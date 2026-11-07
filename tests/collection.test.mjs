import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../worker/index.mjs';
import { database } from '../tools/database.mjs';
import { collectReports, verifyLocal } from '../tools/collect-reports.mjs';

const origin = 'https://djorchard.github.io';
const testRoot = fileURLToPath(new URL('../local-data/collection-tests/', import.meta.url));
async function fixture() {
  await mkdir(testRoot, { recursive: true });
  const output = await mkdtemp(resolve(testRoot, 'run-'));
  const db = database();
  const env = { DB: db, LOCAL_DEVELOPMENT: 'true', ALLOWED_ORIGIN: origin, ADMIN_TOKEN: 'test-key' };
  const transport = (url, options = {}) => worker.fetch(new Request(url, options), env);
  const settings = { apiBaseUrl: 'https://reports.example', token: 'test-key', output, fetchImpl: transport };
  return { db, env, output, transport, settings,
    async report(image = true) {
      const id = crypto.randomUUID(), data = new FormData();
      data.set('id', id); data.set('description', 'The egg vanished.\nPlease investigate.');
      if (image) data.set('image', new Blob([new Uint8Array([255, 216, 255, 224, 0, 0, 255, 217])], { type: 'image/jpeg' }), 'screenshot.jpg');
      assert.equal((await transport('https://reports.example/reports', { method: 'POST', headers: { Origin: origin }, body: data })).status, 201);
      return { id, data };
    },
    async close() {
      db.close();
      const target = resolve(output);
      assert.ok(target.startsWith(resolve(testRoot) + sep));
      await rm(target, { recursive: true, force: true });
    }
  };
}
async function active(f) { return (await (await f.transport('https://reports.example/reports', { headers: { Authorization: 'Bearer test-key' } })).json()).reports; }

test('download, read back, conditionally delete and verify removal; late retries cannot resurrect content', async () => {
  const f = await fixture();
  try {
    const { id, data } = await f.report();
    const result = await collectReports(f.settings);
    assert.deepEqual(result.downloaded, [id]); assert.deepEqual(result.archived, [id]); assert.equal((await active(f)).length, 0);
    const receipt = JSON.parse(await readFile(resolve(f.output, id, 'receipt.json'), 'utf8'));
    assert.equal(receipt.remoteArchived, true); await verifyLocal(resolve(f.output, id), receipt);
    const image = await f.transport(`https://reports.example/reports/${id}/image`, { headers: { Authorization: 'Bearer test-key' } }); assert.equal(image.status, 404);
    assert.equal((await f.transport('https://reports.example/reports', { method: 'POST', headers: { Origin: origin }, body: data })).status, 201);
    assert.equal((await active(f)).length, 0);
    const again = await collectReports(f.settings); assert.deepEqual(again.downloaded, []);
  } finally { await f.close(); }
});
test('missing or corrupted screenshot never authorizes remote deletion', async () => {
  const f = await fixture();
  try {
    await f.report(); let deletes = 0;
    for (const corrupt of [false, true]) {
      await assert.rejects(collectReports({ ...f.settings, fetchImpl: async (url, options) => {
        if (options?.method === 'DELETE') deletes++;
        if (url.endsWith('/image')) return corrupt ? new Response(new Uint8Array([255, 216, 255, 99]), { headers: { 'Content-Type': 'image/jpeg' } }) : new Response(null, { status: 503 });
        return f.transport(url, options);
      }}), /Screenshot download failed|checksum mismatch/);
    }
    assert.equal(deletes, 0); assert.equal((await active(f)).length, 1);
  } finally { await f.close(); }
});
test('failed local file write leaves the remote report intact', async () => {
  const f = await fixture();
  try {
    const { id } = await f.report(false);
    await mkdir(resolve(f.output, id, 'report.txt'), { recursive: true });
    await assert.rejects(collectReports(f.settings));
    assert.equal((await active(f)).length, 1);
  } finally { await f.close(); }
});
test('deletion failure keeps verified local evidence and retries the same report next run', async () => {
  const f = await fixture();
  try {
    const { id } = await f.report(false);
    await assert.rejects(collectReports({ ...f.settings, fetchImpl: (url, options) => options?.method === 'DELETE' ? Promise.resolve(Response.json({ error: 'temporary' }, { status: 503 })) : f.transport(url, options) }), /Remote removal failed/);
    const path = resolve(f.output, id, 'receipt.json'), receipt = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(receipt.remoteArchived, false); await verifyLocal(resolve(f.output, id), receipt);
    assert.equal((await active(f)).length, 1);
    const next = await collectReports(f.settings); assert.deepEqual(next.archived, [id]); assert.deepEqual(next.downloaded, []);
    assert.equal((await active(f)).length, 0);
  } finally { await f.close(); }
});
test('lost deletion response recovers from durable local receipt and remote archived state', async () => {
  const f = await fixture();
  try {
    const { id } = await f.report();
    await assert.rejects(collectReports({ ...f.settings, fetchImpl: async (url, options) => {
      const response = await f.transport(url, options);
      if (options?.method === 'DELETE') throw new TypeError('Simulated lost reply');
      return response;
    }}), /lost reply/);
    assert.equal((await active(f)).length, 0);
    const next = await collectReports(f.settings); assert.deepEqual(next.recovered, [id]);
    const receipt = JSON.parse(await readFile(resolve(f.output, id, 'receipt.json'), 'utf8')); assert.equal(receipt.remoteArchived, true);
  } finally { await f.close(); }
});
test('changed local evidence blocks a retry deletion', async () => {
  const f = await fixture();
  try {
    const { id } = await f.report(false);
    await assert.rejects(collectReports({ ...f.settings, fetchImpl: (url, options) => options?.method === 'DELETE' ? Promise.resolve(Response.json({}, { status: 503 })) : f.transport(url, options) }));
    await writeFile(resolve(f.output, id, 'report.txt'), 'Changed local evidence');
    await assert.rejects(collectReports(f.settings), /Local verification failed/);
    assert.equal((await active(f)).length, 1);
  } finally { await f.close(); }
});
test('delete requires authentication and matching checksum, and does not affect other reports', async () => {
  const f = await fixture();
  try {
    const { id } = await f.report(false); await f.report(false);
    assert.equal((await f.transport(`https://reports.example/reports/${id}`, { method: 'DELETE' })).status, 401);
    assert.equal((await f.transport(`https://reports.example/reports/${id}`, { method: 'DELETE', headers: { Authorization: 'Bearer test-key' } })).status, 428);
    assert.equal((await f.transport(`https://reports.example/reports/${id}`, { method: 'DELETE', headers: { Authorization: 'Bearer test-key', 'If-Match': '0'.repeat(64) } })).status, 409);
    assert.equal((await active(f)).length, 2);
    const first = await collectReports({ ...f.settings, maxReports: 1 }); assert.equal(first.archived.length, 1); assert.equal(first.deferred, true);
    assert.equal((await active(f)).length, 1); await collectReports(f.settings); assert.equal((await active(f)).length, 0);
  } finally { await f.close(); }
});
test('transaction rollback preserves report when archive receipt cannot be committed', async () => {
  const f = await fixture();
  try {
    const { id } = await f.report(false);
    const prepare = f.env.DB.prepare;
    f.env.DB.prepare = (sql) => prepare(sql.startsWith('DELETE FROM reports') ? 'INVALID STATEMENT' : sql);
    await assert.rejects(collectReports(f.settings), /Remote removal failed/);
    f.env.DB.prepare = prepare;
    assert.equal((await active(f)).length, 1);
    assert.equal(await f.db.prepare('SELECT id FROM archived_receipts WHERE id = ?').bind(id).first(), null);
  } finally { await f.close(); }
});
