// Uncertain creates are never replayed. Jira must also obtain a one-time claim.
const KEY = /^report-[a-f0-9]{64}$/;
const ISSUE = /^TME-[1-9][0-9]*$/;
const SOURCES = new Set(['website', 'published', 'studio']);
const json = (value, status = 200) => Response.json(value, { status });
const hash = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(v => v.toString(16).padStart(2, '0')).join('');
const clean = text => text.replace(/[\u2013\u2014]/g, ',');
const escapeHtml = text => text.replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const changes = result => Number(result.meta?.changes ?? result.changes ?? 0);

export async function queueReport(env, report) {
  if (!SOURCES.has(report.source) || typeof report.id !== 'string' || !report.id || report.id.length > 180 || typeof report.description !== 'string' || !report.description.trim() || report.description.length > 4000) throw new Error('Invalid report identity or description');
  const normalized = report.description.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  const key = `report-${await hash(normalized)}`, now = new Date().toISOString();
  const title = clean(String(report.title || report.description.split('\n')[0]).trim()).slice(0, 180);
  const summary = `[${report.source === 'website' ? 'Website' : report.source === 'studio' ? 'Studio' : 'In-game'}] ${title}`;
  await env.DB.batch([
    env.DB.prepare('INSERT INTO jira_report_sources (source, source_id, report_key, created_at, metadata) VALUES (?, ?, ?, ?, ?) ON CONFLICT(source, source_id) DO NOTHING').bind(report.source, report.id, key, now, JSON.stringify(report.metadata || {})),
    env.DB.prepare('INSERT INTO jira_deliveries (report_key, summary, description, source, source_id, created_at, state, delivery_token, evidence_token) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM jira_report_sources WHERE source = ? AND source_id = ? AND report_key = ?) ON CONFLICT(report_key) DO NOTHING')
      .bind(key, summary, report.description, report.source, report.id, now, 'pending', crypto.randomUUID() + crypto.randomUUID(), crypto.randomUUID() + crypto.randomUUID(), report.source, report.id, key)
  ]);
  return env.DB.prepare('SELECT d.report_key, d.state, d.issue_key FROM jira_report_sources s JOIN jira_deliveries d ON d.report_key = s.report_key WHERE s.source = ? AND s.source_id = ?').bind(report.source, report.id).first();
}

export async function dispatchReport(env, key, origin) {
  if (!env.JIRA_WEBHOOK_URL || !env.JIRA_WEBHOOK_TOKEN) return { state: 'unconfigured' };
  const source = await env.DB.prepare('SELECT source FROM jira_deliveries WHERE report_key = ?').bind(key).first();
  if (source?.source === 'website' && env.JIRA_WEBSITE_AUTO_ENABLED !== 'true') return { state: 'website-delivery-held' };
  const target = new URL(env.JIRA_WEBHOOK_URL);
  if (target.protocol !== 'https:' || target.hostname !== 'api-private.atlassian.com' || !target.pathname.startsWith('/automation/webhooks/')) throw new Error('Invalid Jira webhook destination');
  const attempt = await env.DB.prepare("UPDATE jira_deliveries SET state = 'sending', attempted_at = ? WHERE report_key = ? AND state = 'pending'").bind(new Date().toISOString(), key).run();
  if (!changes(attempt)) return { state: 'already-attempted' };
  const row = await env.DB.prepare('SELECT * FROM jira_deliveries WHERE report_key = ?').bind(key).first();
  const evidence = `${origin}/jira/evidence/${key}/${row.evidence_token}`;
  const description = clean(`${row.description}\n\nReported via: ${row.source}\nSource report ID: ${row.source_id}\nOriginal report, context and screenshot: ${evidence}\n\nReported issue, not yet independently confirmed. Report label: ${key}`);
  try {
    // Workers rejects redirect:error before sending. Manual mode prevents
    // forwarding credentials and lets a redirect enter the uncertain hold.
    const response = await fetch(target, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json', 'X-Automation-Webhook-Token': env.JIRA_WEBHOOK_TOKEN }, body: JSON.stringify({ reportKey: key, deliveryToken: row.delivery_token, summary: row.summary, description }) });
    const state = response.ok ? 'accepted' : 'uncertain';
    await env.DB.prepare("UPDATE jira_deliveries SET state = ?, last_http_status = ? WHERE report_key = ? AND state = 'sending'").bind(state, response.status, key).run();
    return { state, httpStatus: response.status };
  } catch (error) {
    console.error('Jira dispatch transport failed', error.name, String(error.message).replaceAll(env.JIRA_WEBHOOK_TOKEN, '[redacted]').replaceAll(env.JIRA_WEBHOOK_URL, '[webhook]').slice(0, 220));
    await env.DB.prepare("UPDATE jira_deliveries SET state = 'uncertain' WHERE report_key = ? AND state = 'sending'").bind(key).run();
    return { state: 'uncertain' };
  }
}

export async function flushJiraQueue(env, origin) {
  if (!env.JIRA_WEBHOOK_URL || !env.JIRA_WEBHOOK_TOKEN) return { configured: false };
  const reports = env.JIRA_WEBSITE_AUTO_ENABLED === 'true' ? (await env.DB.prepare("SELECT r.id, r.description, r.created_at, r.image_type FROM reports r WHERE NOT EXISTS (SELECT 1 FROM jira_report_sources s WHERE s.source = 'website' AND s.source_id = r.id) ORDER BY r.seq LIMIT 20").all()).results : [];
  for (const report of reports) await queueReport(env, { source: 'website', id: report.id, description: report.description, metadata: { reportedAt: report.created_at, hasImage: Boolean(report.image_type) } });
  const { results } = await env.DB.prepare("SELECT report_key FROM jira_deliveries WHERE state = 'pending' AND (source != 'website' OR ? = 'true') ORDER BY created_at LIMIT 10").bind(env.JIRA_WEBSITE_AUTO_ENABLED || 'false').all();
  for (const row of results) await dispatchReport(env, row.report_key, origin);
  return { configured: true, recovered: reports.length, attempted: results.length };
}

async function body(request) {
  if (Number(request.headers.get('Content-Length')) > 600000) return null;
  const reader = request.body?.getReader(); if (!reader) return null;
  const chunks = []; let length = 0;
  while (true) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > 600000) { await reader.cancel(); return null; } chunks.push(part.value); }
  try { return JSON.parse(await new Blob(chunks).text()); } catch { return null; }
}

export async function jiraRoute(request, env, admin, ctx) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/jira/')) return null;
  if (['/jira/claim', '/jira/receipt'].includes(url.pathname)) {
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const data = await body(request);
    if (!data || !KEY.test(data.key || '') || typeof data.token !== 'string' || data.token.length !== 72) return json({ error: 'Invalid delivery' }, 400);
    const row = await env.DB.prepare('SELECT delivery_token, state, issue_key FROM jira_deliveries WHERE report_key = ?').bind(data.key).first();
    if (!row || await hash(row.delivery_token) !== await hash(data.token)) return json({ error: 'Invalid delivery' }, 403);
    if (url.pathname === '/jira/claim') {
      const result = await env.DB.prepare("UPDATE jira_deliveries SET state = 'claimed', claimed_at = ? WHERE report_key = ? AND state IN ('sending', 'accepted', 'uncertain')").bind(new Date().toISOString(), data.key).run();
      return json({ allow: changes(result) === 1, issueKey: row.issue_key || null });
    }
    if (!ISSUE.test(data.issueKey || '')) return json({ error: 'Invalid Jira issue key' }, 400);
    if (row.issue_key && row.issue_key !== data.issueKey) return json({ error: 'Conflicting Jira receipt' }, 409);
    if (!['claimed', 'delivered'].includes(row.state)) return json({ error: 'Delivery was not claimed' }, 409);
    const result = await env.DB.prepare("UPDATE jira_deliveries SET state = 'delivered', issue_key = ?, delivered_at = ? WHERE report_key = ? AND (issue_key IS NULL OR issue_key = ?)").bind(data.issueKey, new Date().toISOString(), data.key, data.issueKey).run();
    return changes(result) === 1 ? json({ delivered: true, issueKey: data.issueKey }) : json({ error: 'Conflicting Jira receipt' }, 409);
  }
  const evidence = /^\/jira\/evidence\/(report-[a-f0-9]{64})\/([a-f0-9-]{72})(\/image)?$/.exec(url.pathname);
  if (evidence) {
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    const row = await env.DB.prepare('SELECT * FROM jira_deliveries WHERE report_key = ? AND evidence_token = ?').bind(evidence[1], evidence[2]).first();
    if (!row) return json({ error: 'Not found' }, 404);
    const { results } = await env.DB.prepare('SELECT source, source_id, created_at, metadata FROM jira_report_sources WHERE report_key = ? ORDER BY created_at').bind(row.report_key).all();
    const website = results.find(r => r.source === 'website');
    const report = website ? await env.DB.prepare('SELECT image, image_type FROM reports WHERE id = ?').bind(website.source_id).first() : null;
    if (evidence[3]) {
      if (!report?.image) return json({ error: 'Screenshot unavailable' }, 404);
      return new Response(Array.isArray(report.image) ? new Uint8Array(report.image) : report.image, { headers: { 'Content-Type': 'image/jpeg', 'Referrer-Policy': 'no-referrer' } });
    }
    const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>Game bug report</title><body><h1>${escapeHtml(row.summary)}</h1><pre style="white-space:pre-wrap">${escapeHtml(clean(row.description))}</pre><p>Jira: ${escapeHtml(row.issue_key || 'Awaiting receipt')}</p><pre>${escapeHtml(clean(JSON.stringify(results, null, 2)))}</pre>${report?.image ? `<img style="max-width:100%" alt="Submitted screenshot" src="${url.pathname}/image">` : '<p>No retained screenshot.</p>'}</body></html>`;
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer' } });
  }
  await admin(request, env);
  if (url.pathname === '/jira/import' && request.method === 'POST') {
    const data = await body(request);
    if (!data || !Array.isArray(data.reports) || data.reports.length > 100 || data.reports.some(r => !['published', 'studio'].includes(r.source))) return json({ error: 'Invalid import batch' }, 400);
    const rows = [];
    for (const report of data.reports) rows.push(await queueReport(env, report));
    const dispatch = async () => { for (const row of rows) await dispatchReport(env, row.report_key, url.origin); };
    if (ctx?.waitUntil) ctx.waitUntil(dispatch()); else await dispatch();
    return json({ queued: rows });
  }
  if (url.pathname === '/jira/status' && request.method === 'GET') {
    const { results } = await env.DB.prepare('SELECT report_key, summary, source, source_id, state, issue_key, attempted_at, claimed_at, delivered_at, last_http_status FROM jira_deliveries ORDER BY created_at DESC LIMIT 500').all();
    return json({ configured: Boolean(env.JIRA_WEBHOOK_URL && env.JIRA_WEBHOOK_TOKEN), websiteImmediateEnabled: env.JIRA_WEBSITE_AUTO_ENABLED === 'true', deliveries: results });
  }
  if (url.pathname === '/jira/dispatch' && request.method === 'POST') {
    const { results } = await env.DB.prepare("SELECT report_key FROM jira_deliveries WHERE state = 'pending' ORDER BY created_at LIMIT 20").all();
    for (const row of results) await dispatchReport(env, row.report_key, url.origin);
    return json({ attempted: results.length });
  }
  return json({ error: 'Not found' }, 404);
}
