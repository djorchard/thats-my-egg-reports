const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY = 800_000;
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function json(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }); }
async function limitedBody(request) {
  if (Number(request.headers.get('Content-Length')) > MAX_BODY) throw new HttpError(413, 'Please choose a smaller screenshot.');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'Your report is empty.');
  const chunks = []; let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_BODY) { await reader.cancel(); throw new HttpError(413, 'Please choose a smaller screenshot.'); }
    chunks.push(value);
  }
  return new Response(new Blob(chunks), { headers: { 'Content-Type': request.headers.get('Content-Type') || '' } }).formData().catch(() => { throw new HttpError(400, 'Invalid report format.'); });
}
async function digest(bytes) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((v) => v.toString(16).padStart(2, '0')).join(''); }
async function admin(request, env) {
  const actual = request.headers.get('Authorization') || '';
  if (!env.ADMIN_TOKEN || (await digest(new TextEncoder().encode(actual))) !== (await digest(new TextEncoder().encode(`Bearer ${env.ADMIN_TOKEN}`)))) throw new HttpError(401, 'Enter a valid developer access key.');
}
async function create(request, env) {
  if (request.headers.get('Origin') !== env.ALLOWED_ORIGIN) throw new HttpError(403, 'This website cannot submit reports.');
  const local = env.LOCAL_DEVELOPMENT === 'true';
  if (!local && (!env.TURNSTILE_SECRET || !env.REPORT_LIMITER || !env.ADMIN_TOKEN)) throw new HttpError(503, 'Reports are not open yet. Please check back soon.');
  if (env.REPORT_LIMITER) {
    const result = await env.REPORT_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') || 'unknown' });
    if (!result.success) throw new HttpError(429, 'You’ve sent several reports. Please wait a minute and try again.');
  }
  const data = await limitedBody(request);
  const id = data.get('id'), rawDescription = data.get('description'), image = data.get('image');
  const description = typeof rawDescription === 'string' ? rawDescription.replace(/\r\n/g, '\n') : rawDescription;
  if (typeof id !== 'string' || !UUID.test(id) || typeof description !== 'string' || !description.trim() || description.length > 4000) throw new HttpError(400, 'Add a description of up to 4,000 characters.');
  let bytes = null;
  if (image !== null) {
    if (!(image instanceof Blob) || image.type !== 'image/jpeg' || image.size > 750_000 || image.size < 4) throw new HttpError(400, 'Use a screenshot prepared by this page.');
    bytes = await image.arrayBuffer();
    const signature = new Uint8Array(bytes, 0, 3);
    if (signature[0] !== 255 || signature[1] !== 216 || signature[2] !== 255) throw new HttpError(400, 'Invalid screenshot.');
  }
  const contentHash = await digest(new TextEncoder().encode(`${description}\n${bytes ? await digest(bytes) : ''}`));
  if (!local) {
    const token = data.get('token');
    if (typeof token !== 'string' || !token || token.length > 2048) throw new HttpError(400, 'Please complete the verification again.');
    const verify = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, remoteip: request.headers.get('CF-Connecting-IP') || '' }), signal: AbortSignal.timeout(10_000)
    });
    const result = await verify.json();
    if (!result.success || result.hostname !== env.TURNSTILE_HOSTNAME || result.action !== 'report') throw new HttpError(400, 'Verification expired. Please verify again and resubmit.');
  }
  await env.DB.prepare('INSERT INTO reports (id, created_at, description, image, image_type, content_hash) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING')
    .bind(id, new Date().toISOString(), description, bytes, bytes ? 'image/jpeg' : null, contentHash).run();
  const saved = await env.DB.prepare('SELECT id, content_hash FROM reports WHERE id = ? UNION ALL SELECT id, content_hash FROM archived_receipts WHERE id = ? LIMIT 1').bind(id, id).first();
  if (!saved || saved.content_hash !== contentHash) throw new HttpError(409, 'This report changed. Edit your description and submit again.');
  return json({ id: saved.id }, 201);
}
async function route(request, env) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') {
    if (request.headers.get('Origin') !== env.ALLOWED_ORIGIN) throw new HttpError(403, 'Origin not allowed.');
    return new Response(null, { status: 204 });
  }
  if (url.pathname === '/reports' && request.method === 'POST') return create(request, env);
  await admin(request, env);
  if (url.pathname === '/reports' && request.method === 'GET') {
    const since = url.searchParams.get('since') || '0';
    if (!/^\d{1,15}$/.test(since) || !Number.isSafeInteger(Number(since))) throw new HttpError(400, 'Invalid report cursor.');
    const { results } = await env.DB.prepare('SELECT seq, id, created_at, description, image_type, content_hash FROM reports WHERE seq > ? ORDER BY seq ASC LIMIT 50').bind(Number(since)).all();
    return json({ reports: results.map(({ image_type, ...report }) => ({ ...report, hasImage: Boolean(image_type) })), nextCursor: results.at(-1)?.seq || Number(since) });
  }
  const archive = /^\/reports\/([a-f0-9-]+)$/.exec(url.pathname);
  if (archive && UUID.test(archive[1]) && request.method === 'GET') {
    const report = await env.DB.prepare('SELECT seq, id, created_at, description, image_type, content_hash FROM reports WHERE id = ?').bind(archive[1]).first();
    if (report) {
      const { image_type, ...metadata } = report;
      return json({ ...metadata, hasImage: Boolean(image_type), archived: false });
    }
    const receipt = await env.DB.prepare('SELECT id, content_hash FROM archived_receipts WHERE id = ?').bind(archive[1]).first();
    if (receipt) return json({ ...receipt, archived: true });
    throw new HttpError(404, 'Report not found.');
  }
  if (archive && UUID.test(archive[1]) && request.method === 'DELETE') {
    const id = archive[1], hash = request.headers.get('If-Match');
    if (!hash || !/^[a-f0-9]{64}$/.test(hash)) throw new HttpError(428, 'A verified report checksum is required.');
    const current = await env.DB.prepare('SELECT content_hash FROM reports WHERE id = ? UNION ALL SELECT content_hash FROM archived_receipts WHERE id = ? LIMIT 1').bind(id, id).first();
    if (!current) throw new HttpError(404, 'Report not found.');
    if (current.content_hash !== hash) throw new HttpError(409, 'The saved report does not match the downloaded copy.');
    await env.DB.batch([
      env.DB.prepare('INSERT INTO archived_receipts (id, content_hash, archived_at) SELECT id, content_hash, ? FROM reports WHERE id = ? AND content_hash = ? ON CONFLICT(id) DO NOTHING').bind(new Date().toISOString(), id, hash),
      env.DB.prepare('DELETE FROM reports WHERE id = ? AND content_hash = ?').bind(id, hash)
    ]);
    return json({ id, archived: true });
  }
  const match = /^\/reports\/([a-f0-9-]+)\/image$/.exec(url.pathname);
  if (match && UUID.test(match[1]) && request.method === 'GET') {
    const report = await env.DB.prepare('SELECT image, image_type FROM reports WHERE id = ?').bind(match[1]).first();
    if (!report?.image) throw new HttpError(404, 'Screenshot not found.');
    const body = Array.isArray(report.image) ? new Uint8Array(report.image) : report.image;
    return new Response(body, { headers: { 'Content-Type': report.image_type, 'Content-Disposition': `inline; filename="${match[1]}.jpg"` } });
  }
  throw new HttpError(404, 'Not found.');
}
export default {
  async fetch(request, env) {
    let response;
    try { response = await route(request, env); }
    catch (error) {
      if (!(error instanceof HttpError)) console.error('Report service failed:', error.name);
      response = json({ error: error instanceof HttpError ? error.message : 'We couldn’t save your report right now. Your image and message are still here. Please try again.' }, error instanceof HttpError ? error.status : 503);
    }
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'no-store'); headers.set('X-Content-Type-Options', 'nosniff'); headers.set('Vary', 'Origin');
    if (request.headers.get('Origin') === env.ALLOWED_ORIGIN) {
      headers.set('Access-Control-Allow-Origin', env.ALLOWED_ORIGIN);
      headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, If-Match');
    }
    return new Response(response.body, { status: response.status, headers });
  }
};
