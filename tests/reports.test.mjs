import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.mjs';
import { database } from '../tools/database.mjs';

const origin = 'https://djorchard.github.io';
function setup() {
  const db = database();
  return { db, env: { DB: db, LOCAL_DEVELOPMENT: 'true', ALLOWED_ORIGIN: origin, ADMIN_TOKEN: 'test-only-key' } };
}
function submission({ id = crypto.randomUUID(), description = 'The egg disappeared when I picked it up.', image = true, token = '' } = {}) {
  const data = new FormData(); data.set('id', id); data.set('description', description); data.set('token', token);
  if (image) data.set('image', new Blob([new Uint8Array([255, 216, 255, 224, 0, 0, 255, 217])], { type: 'image/jpeg' }), 'screenshot.jpg');
  return { id, request: new Request('https://reports.example/reports', { method: 'POST', headers: { Origin: origin }, body: data }) };
}
function get(path, key = 'test-only-key') { return new Request(`https://reports.example${path}`, { headers: key ? { Authorization: `Bearer ${key}` } : {} }); }

test('save, retrieve private metadata and fetch exact screenshot bytes', async () => {
  const { db, env } = setup();
  try {
    const report = submission(); const saved = await worker.fetch(report.request, env);
    assert.equal(saved.status, 201); assert.deepEqual(await saved.json(), { id: report.id });
    const list = await worker.fetch(get('/reports'), env); const batch = await list.json();
    assert.equal(batch.reports.length, 1); assert.equal(batch.reports[0].hasImage, true);
    assert.equal('image' in batch.reports[0], false);
    const image = await worker.fetch(get(`/reports/${report.id}/image`), env);
    assert.equal(image.headers.get('Content-Type'), 'image/jpeg');
    assert.deepEqual([...new Uint8Array(await image.arrayBuffer())], [255, 216, 255, 224, 0, 0, 255, 217]);
  } finally { db.close(); }
});
test('network retry is idempotent; reused identity with different content is rejected', async () => {
  const { db, env } = setup(); const id = crypto.randomUUID();
  try {
    const responses = await Promise.all([1, 2, 3].map(() => worker.fetch(submission({ id }).request, env)));
    assert.ok(responses.every((response) => response.status === 201));
    const list = await (await worker.fetch(get('/reports'), env)).json(); assert.equal(list.reports.length, 1);
    assert.equal((await worker.fetch(submission({ id, description: 'Different report' }).request, env)).status, 409);
  } finally { db.close(); }
});
test('reports and screenshots require developer authentication; errors are not cached', async () => {
  const { db, env } = setup();
  try {
    for (const path of ['/reports', `/reports/${crypto.randomUUID()}/image`]) {
      for (const key of ['', 'wrong']) {
        const response = await worker.fetch(get(path, key), env); assert.equal(response.status, 401);
        assert.equal(response.headers.get('Cache-Control'), 'no-store');
      }
    }
    assert.equal((await worker.fetch(get('/reports?since=1%20OR%201=1'), env)).status, 400);
  } finally { db.close(); }
});
test('description-only reports, text preservation and incremental pagination', async () => {
  const { db, env } = setup();
  try {
    const text = '<script>alert(1)</script>\nA second line';
    assert.equal((await worker.fetch(submission({ image: false, description: text }).request, env)).status, 201);
    const first = await (await worker.fetch(get('/reports'), env)).json();
    assert.equal(first.reports[0].description, text); assert.equal(first.reports[0].hasImage, false);
    await worker.fetch(submission({ image: false }).request, env);
    const next = await (await worker.fetch(get(`/reports?since=${first.nextCursor}`), env)).json();
    assert.equal(next.reports.length, 1); assert.ok(next.nextCursor > first.nextCursor);
  } finally { db.close(); }
});
test('bad origin, empty/oversized text, unsupported images and over-limit streams are rejected', async () => {
  const { db, env } = setup();
  try {
    for (const description of ['', '   ', 'x'.repeat(4001)]) assert.equal((await worker.fetch(submission({ description }).request, env)).status, 400);
    const wrongOrigin = submission().request;
    wrongOrigin.headers.set('Origin', 'https://unrelated.example');
    const denied = await worker.fetch(wrongOrigin, env); assert.equal(denied.status, 403); assert.equal(denied.headers.has('Access-Control-Allow-Origin'), false);
    const data = new FormData(); data.set('id', crypto.randomUUID()); data.set('description', 'A bug');
    data.set('image', new Blob(['<svg></svg>'], { type: 'image/svg+xml' }), 'bad.svg');
    assert.equal((await worker.fetch(new Request('https://reports.example/reports', { method: 'POST', headers: { Origin: origin }, body: data }), env)).status, 400);
    const oversized = new Request('https://reports.example/reports', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(800_001) });
    assert.equal((await worker.fetch(oversized, env)).status, 413);
    assert.equal((await worker.fetch(get('/reports'), env)).headers.get('Access-Control-Allow-Origin'), null);
  } finally { db.close(); }
});
test('production fails closed without verification and rate limiter; rate rejection writes nothing', async () => {
  const { db, env } = setup();
  try {
    env.LOCAL_DEVELOPMENT = 'false';
    assert.equal((await worker.fetch(submission().request, env)).status, 503);
    env.TURNSTILE_SECRET = 'test-secret'; env.REPORT_LIMITER = { limit: async () => ({ success: false }) };
    assert.equal((await worker.fetch(submission().request, env)).status, 429);
    const list = await (await worker.fetch(get('/reports'), env)).json(); assert.equal(list.reports.length, 0);
  } finally { db.close(); }
});
test('production checks Turnstile hostname, action and success before saving', async () => {
  const { db, env } = setup(); const originalFetch = globalThis.fetch;
  try {
    Object.assign(env, { LOCAL_DEVELOPMENT: 'false', TURNSTILE_SECRET: 'test-secret', TURNSTILE_HOSTNAME: 'djorchard.github.io', REPORT_LIMITER: { limit: async () => ({ success: true }) } });
    for (const result of [{ success: false }, { success: true, hostname: 'wrong', action: 'report' }, { success: true, hostname: env.TURNSTILE_HOSTNAME, action: 'wrong' }]) {
      globalThis.fetch = async () => Response.json(result);
      assert.equal((await worker.fetch(submission({ token: 'test-token' }).request, env)).status, 400);
    }
    globalThis.fetch = async () => Response.json({ success: true, hostname: env.TURNSTILE_HOSTNAME, action: 'report' });
    assert.equal((await worker.fetch(submission({ token: 'test-token' }).request, env)).status, 201);
  } finally { globalThis.fetch = originalFetch; db.close(); }
});
test('database failure reports failure instead of pretending to save', async () => {
  const { db, env } = setup(); db.close();
  const response = await worker.fetch(submission().request, env);
  assert.equal(response.status, 503); assert.ok((await response.json()).error.includes('couldn’t save'));
});
