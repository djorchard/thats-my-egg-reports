import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.mjs';
import { queueReport, dispatchReport, flushJiraQueue } from '../worker/jira.mjs';
import { database } from '../tools/database.mjs';

function setup() {
  const DB = database();
  return { DB, ADMIN_TOKEN: 'test-admin', ALLOWED_ORIGIN: 'https://djorchard.github.io', JIRA_WEBSITE_AUTO_ENABLED: 'true', JIRA_WEBHOOK_URL: 'https://api-private.atlassian.com/automation/webhooks/test', JIRA_WEBHOOK_TOKEN: 'test-token' };
}
const report = (id = 'one', description = 'The egg disappeared after I picked it up.') => ({ source: 'published', id, title: 'Egg disappears', description });
const req = (path, value, token) => new Request(`https://reports.example${path}`, { method: value ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(value ? { body: JSON.stringify(value) } : {}) });

test('concurrent reimports, repeated content and changed content retain one ticket identity', async () => {
  const env = setup();
  try {
    const rows = await Promise.all([queueReport(env, report()), queueReport(env, report()), queueReport(env, report('two'))]);
    assert.equal(new Set(rows.map(r => r.report_key)).size, 1);
    const changed = await queueReport(env, report('one', 'A corrected description of the same report.'));
    assert.equal(changed.report_key, rows[0].report_key);
    assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM jira_deliveries').first()).n, 1);
    assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM jira_report_sources').first()).n, 2);
  } finally { env.DB.close(); }
});

test('overlapping dispatches and an uncertain network outcome never replay creation', async () => {
  const env = setup(), originalFetch = globalThis.fetch;
  try {
    const row = await queueReport(env, report()); let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error('Lost response after send'); };
    await Promise.all([dispatchReport(env, row.report_key, 'https://reports.example'), dispatchReport(env, row.report_key, 'https://reports.example')]);
    await dispatchReport(env, row.report_key, 'https://reports.example');
    assert.equal(calls, 1);
    assert.equal((await env.DB.prepare('SELECT state FROM jira_deliveries').first()).state, 'uncertain');
  } finally { globalThis.fetch = originalFetch; env.DB.close(); }
});

test('native flow retries get one claim, receipts are authenticated and preserve the first key', async () => {
  const env = setup(), originalFetch = globalThis.fetch;
  try {
    const row = await queueReport(env, report());
    globalThis.fetch = async () => Response.json({ accepted: true });
    await dispatchReport(env, row.report_key, 'https://reports.example');
    const privateRow = await env.DB.prepare('SELECT * FROM jira_deliveries').first();
    const value = { key: row.report_key, token: privateRow.delivery_token };
    assert.equal((await worker.fetch(req('/jira/claim', { ...value, token: 'x'.repeat(72) }), env)).status, 403);
    const claims = await Promise.all([worker.fetch(req('/jira/claim', value), env), worker.fetch(req('/jira/claim', value), env)]);
    assert.equal((await Promise.all(claims.map(r => r.json()))).filter(r => r.allow).length, 1);
    const receipt = { ...value, issueKey: 'TME-99' };
    assert.equal((await worker.fetch(req('/jira/receipt', receipt), env)).status, 200);
    assert.equal((await worker.fetch(req('/jira/receipt', receipt), env)).status, 200);
    assert.equal((await worker.fetch(req('/jira/receipt', { ...receipt, issueKey: 'TME-100' }), env)).status, 409);
    assert.equal((await (await worker.fetch(req('/jira/claim', value), env)).json()).allow, false);
    assert.equal((await env.DB.prepare('SELECT issue_key FROM jira_deliveries').first()).issue_key, 'TME-99');
  } finally { globalThis.fetch = originalFetch; env.DB.close(); }
});

test('callback during the webhook request cannot be overwritten by its later acknowledgment', async () => {
  const env = setup(), originalFetch = globalThis.fetch;
  try {
    const row = await queueReport(env, report());
    globalThis.fetch = async (_url, options) => {
      assert.equal(options.redirect, 'manual', 'Cloudflare requires manual mode to reject credential redirects');
      const payload = JSON.parse(options.body), identity = { key: payload.reportKey, token: payload.deliveryToken };
      assert.equal((await (await worker.fetch(req('/jira/claim', identity), env)).json()).allow, true);
      await worker.fetch(req('/jira/receipt', { ...identity, issueKey: 'TME-99' }), env);
      return Response.json({ accepted: true });
    };
    await dispatchReport(env, row.report_key, 'https://reports.example');
    assert.equal((await env.DB.prepare('SELECT state FROM jira_deliveries').first()).state, 'delivered');
  } finally { globalThis.fetch = originalFetch; env.DB.close(); }
});

test('only authenticated imports write data; evidence is scoped and report HTML is escaped', async () => {
  const env = setup(); env.JIRA_WEBHOOK_URL = undefined;
  try {
    assert.equal((await worker.fetch(req('/jira/import', { reports: [report()] }), env)).status, 401);
    assert.equal((await worker.fetch(req('/jira/import', { reports: [report('one', '<script>bad()</script>')] }, 'test-admin'), env)).status, 200);
    const row = await env.DB.prepare('SELECT * FROM jira_deliveries').first();
    assert.equal((await worker.fetch(req(`/jira/evidence/${row.report_key}/${'x'.repeat(72)}`), env)).status, 401);
    const evidence = await worker.fetch(req(`/jira/evidence/${row.report_key}/${row.evidence_token}`), env);
    assert.equal(evidence.status, 200); assert.match(await evidence.text(), /&lt;script&gt;/);
    const status = await (await worker.fetch(req('/jira/status', null, 'test-admin'), env)).text();
    assert.ok(!status.includes(row.delivery_token)); assert.ok(!status.includes(row.evidence_token));
  } finally { env.DB.close(); }
});

test('recovery queues a retained website report and never replays an accepted delivery', async () => {
  const env = setup(), originalFetch = globalThis.fetch;
  try {
    const id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO reports (id, created_at, description, content_hash) VALUES (?, ?, ?, ?)').bind(id, new Date().toISOString(), 'The screenshot upload failed after reporting an egg.', 'a'.repeat(64)).run();
    let calls = 0; globalThis.fetch = async () => { calls++; return Response.json({ accepted: true }); };
    assert.equal((await flushJiraQueue(env, 'https://reports.example')).recovered, 1);
    assert.equal((await flushJiraQueue(env, 'https://reports.example')).recovered, 0);
    assert.equal(calls, 1);
    assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM reports').first()).n, 1);
  } finally { globalThis.fetch = originalFetch; env.DB.close(); }
});

test('a website submission succeeds independently of Jira and retry still queues one report', async () => {
  const env = setup(); env.LOCAL_DEVELOPMENT = 'true';
  const tasks = [], id = crypto.randomUUID();
  env.JIRA_WEBHOOK_URL = undefined;
  try {
    for (let i = 0; i < 2; i++) {
      const data = new FormData(); data.set('id', id); data.set('description', 'The egg disappeared from my garden.');
      const response = await worker.fetch(new Request('https://reports.example/reports', { method: 'POST', headers: { Origin: env.ALLOWED_ORIGIN }, body: data }), env, { waitUntil: p => tasks.push(p) });
      assert.equal(response.status, 201);
    }
    await Promise.all(tasks);
    assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM jira_deliveries').first()).n, 1);
    assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM reports').first()).n, 1);
  } finally { env.DB.close(); }
});

test('the single-writer hold blocks website creation and backfill while retaining the report', async () => {
  const env = setup(), originalFetch = globalThis.fetch;
  env.JIRA_WEBSITE_AUTO_ENABLED = 'false'; env.LOCAL_DEVELOPMENT = 'true';
  let calls = 0; globalThis.fetch = async () => { calls++; return Response.json({}); };
  try {
    const id = crypto.randomUUID(), data = new FormData(); data.set('id', id); data.set('description', 'The website monitor already owns this report.');
    assert.equal((await worker.fetch(new Request('https://reports.example/reports', { method: 'POST', headers: { Origin: env.ALLOWED_ORIGIN }, body: data }), env)).status, 201);
    assert.equal((await flushJiraQueue(env, 'https://reports.example')).recovered, 0);
    const row = await queueReport(env, { source: 'website', id, description: 'The website monitor already owns this report.' });
    assert.equal((await dispatchReport(env, row.report_key, 'https://reports.example')).state, 'website-delivery-held');
    assert.equal(calls, 0);
    assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM reports').first()).n, 1);
  } finally { globalThis.fetch = originalFetch; env.DB.close(); }
});
