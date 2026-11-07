import { mkdir, readFile, open, rename, unlink, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const contentHash = (description, image) => sha256(`${description}\n${image ? sha256(image) : ''}`);

async function atomicWrite(path, bytes) {
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temp, path);
}
const jsonBytes = (value) => JSON.stringify(value, null, 2) + '\n';
async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')); }
async function optionalJson(path) {
  try { return await readJson(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function verifyLocal(folder, receipt) {
  const expectedNames = receipt.hasImage ? ['report.json', 'report.txt', 'screenshot.jpg'] : ['report.json', 'report.txt'];
  for (const name of expectedNames) {
    if (!receipt.files?.[name] || sha256(await readFile(resolve(folder, name))) !== receipt.files[name]) throw new Error(`Local verification failed for ${receipt.id}/${name}. Remote report retained.`);
  }
  const report = await readJson(resolve(folder, 'report.json'));
  const image = receipt.hasImage ? await readFile(resolve(folder, 'screenshot.jpg')) : null;
  if (report.id !== receipt.id || report.content_hash !== receipt.contentHash || report.hasImage !== receipt.hasImage || contentHash(report.description, image) !== receipt.contentHash) throw new Error(`Local report checksum mismatch for ${receipt.id}. Remote report retained.`);
  return report;
}

export async function collectReports({ apiBaseUrl, token, output, fetchImpl = fetch, maxReports = 100, timeBudgetMs = 120_000 }) {
  const base = (apiBaseUrl || '').replace(/\/$/, '');
  if (!base || !token) throw new Error('Cloudflare collection is not configured. Set REPORT_API_URL and private REPORT_ADMIN_TOKEN. Coverage is unknown.');
  const endpoint = new URL(base);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)))) throw new Error('Use the HTTPS report API URL, without credentials, query or fragment.');
  output = resolve(output);
  await mkdir(output, { recursive: true });
  const lockPath = resolve(output, '.collection.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('A report collector lock exists. Check its owning process before retrying; do not run overlapping collectors.'); throw error; }
  const summary = { checkedAt: new Date().toISOString(), downloaded: [], archived: [], recovered: [], deferred: false, output };
  const deadline = Date.now() + timeBudgetMs;
  async function request(path, options = {}) {
    return fetchImpl(`${base}${path}`, { ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers }, signal: AbortSignal.timeout(45_000), redirect: 'error' });
  }
  async function metadata(id) {
    const response = await request(`/reports/${id}`);
    if (!response.ok) throw new Error(`Cannot verify remote report state (${response.status}). Local evidence retained.`);
    return response.json();
  }
  async function finish(folder, receipt) {
    const state = await metadata(receipt.id);
    if (state.id !== receipt.id || state.content_hash !== receipt.contentHash || state.archived !== true) throw new Error(`Remote removal could not be verified for ${receipt.id}. Local evidence retained.`);
    receipt.remoteArchived = true; receipt.remoteVerifiedAt = new Date().toISOString();
    await atomicWrite(resolve(folder, 'receipt.json'), jsonBytes(receipt));
    summary.archived.push(receipt.id);
  }
  try {
    await lock.writeFile(jsonBytes({ pid: process.pid, startedAt: new Date().toISOString() })); await lock.sync();
    for (const entry of await readdir(output, { withFileTypes: true })) {
      if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
      const folder = resolve(output, entry.name), receipt = await optionalJson(resolve(folder, 'receipt.json'));
      if (!receipt || receipt.remoteArchived) continue;
      if (receipt.id !== entry.name || !HASH.test(receipt.contentHash)) throw new Error('Invalid local receipt. Preserve local and remote evidence.');
      if (Date.now() >= deadline) { summary.deferred = true; break; }
      await verifyLocal(folder, receipt);
      const state = await metadata(receipt.id);
      if (state.archived === true) {
        await finish(folder, receipt); summary.recovered.push(receipt.id);
      }
    }
    let processed = 0;
    while (!summary.deferred && processed < maxReports) {
      if (Date.now() >= deadline) { summary.deferred = true; break; }
      const response = await request('/reports?since=0');
      if (!response.ok) throw new Error(`Cloudflare report listing failed (${response.status}). Coverage is unknown.`);
      const batch = await response.json();
      if (!Array.isArray(batch.reports) || batch.reports.length > 50) throw new Error('Invalid Cloudflare report response. Nothing removed.');
      if (!batch.reports.length) break;
      for (const report of batch.reports) {
        if (processed >= maxReports || Date.now() >= deadline) { summary.deferred = true; break; }
        if (!UUID.test(report.id) || !HASH.test(report.content_hash) || typeof report.description !== 'string' || typeof report.hasImage !== 'boolean') throw new Error('Invalid report identity or checksum. Nothing removed.');
        const folder = resolve(output, report.id); await mkdir(folder, { recursive: true });
        let receipt = await optionalJson(resolve(folder, 'receipt.json'));
        if (receipt) {
          if (receipt.contentHash !== report.content_hash) throw new Error(`Report identity changed for ${report.id}. Preserve local and remote evidence.`);
          await verifyLocal(folder, receipt);
        } else {
          let image = null;
          if (report.hasImage) {
            const screenshot = await request(`/reports/${report.id}/image`);
            if (!screenshot.ok || !screenshot.headers.get('Content-Type')?.startsWith('image/jpeg')) throw new Error(`Screenshot download failed for ${report.id}. Remote report retained.`);
            image = Buffer.from(await screenshot.arrayBuffer());
            if (image.length > 750_000 || image.length < 4 || image[0] !== 255 || image[1] !== 216 || image[2] !== 255) throw new Error(`Invalid screenshot for ${report.id}. Remote report retained.`);
          }
          if (contentHash(report.description, image) !== report.content_hash) throw new Error(`Download checksum mismatch for ${report.id}. Remote report retained.`);
          const files = { 'report.json': jsonBytes(report), 'report.txt': `Report ${report.id}\nReceived: ${report.created_at}\n\n${report.description}\n`, ...(image ? { 'screenshot.jpg': image } : {}) };
          for (const [name, bytes] of Object.entries(files)) await atomicWrite(resolve(folder, name), bytes);
          receipt = { id: report.id, contentHash: report.content_hash, hasImage: report.hasImage, downloadedAt: new Date().toISOString(), remoteArchived: false, files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, sha256(bytes)])) };
          await atomicWrite(resolve(folder, 'receipt.json'), jsonBytes(receipt));
          summary.downloaded.push(report.id);
        }
        await verifyLocal(folder, receipt);
        const removed = await request(`/reports/${report.id}`, { method: 'DELETE', headers: { 'If-Match': receipt.contentHash } });
        const acknowledgement = await removed.json().catch(() => ({}));
        if (!removed.ok || acknowledgement.id !== report.id || acknowledgement.archived !== true) throw new Error(`Remote removal failed for ${report.id} (${removed.status}). Verified local evidence retained; retry next run.`);
        await finish(folder, receipt);
        processed++;
      }
    }
    if (processed >= maxReports) summary.deferred = true;
    await atomicWrite(resolve(output, 'last-collection.json'), jsonBytes(summary));
    return summary;
  } finally { await lock.close(); await unlink(lockPath); }
}
