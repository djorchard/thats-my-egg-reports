import test from 'node:test';
import assert from 'node:assert/strict';
import { createReportFetch } from '../tools/report-fetch.mjs';

test('normal API errors are returned without retrying or changing authentication', async () => {
  const original = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = async (request) => {
      calls++;
      assert.equal(request.headers.get('Authorization'), 'Bearer test-key');
      assert.equal(request.method, 'DELETE');
      assert.equal(request.redirect, 'error');
      return Response.json({ error: 'Denied' }, { status: 401 });
    };
    const response = await createReportFetch('https://reports.example')('https://reports.example/reports/test', { method: 'DELETE', headers: { Authorization: 'Bearer test-key' } });
    assert.equal(response.status, 401); assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});
test('an uncertain network outcome is never replayed through the DNS fallback', async () => {
  const original = globalThis.fetch;
  try {
    let calls = 0;
    const lost = new TypeError('Connection reset', { cause: { code: 'ECONNRESET' } });
    globalThis.fetch = async () => { calls++; throw lost; };
    await assert.rejects(createReportFetch('https://reports.example')('https://reports.example/reports', { method: 'POST', body: 'test' }), (error) => error === lost);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});
test('DNS fallback is not used for unrelated origins or insecure HTTP', async () => {
  const original = globalThis.fetch;
  try {
    let calls = 0;
    const dns = new TypeError('Unknown host', { cause: { code: 'ENOTFOUND' } });
    globalThis.fetch = async () => { calls++; throw dns; };
    const request = createReportFetch('https://reports.example');
    await assert.rejects(request('https://unrelated.example/reports'), (error) => error === dns);
    await assert.rejects(request('http://reports.example/reports'), (error) => error === dns);
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});
