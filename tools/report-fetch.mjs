import https from 'node:https';
import { isIP } from 'node:net';

// Keep normal networking first. A failed DNS lookup is a pre-send failure.
// This fallback is scoped to the configured API and retains hostname/TLS checks.
export function createReportFetch(apiBaseUrl) {
  const origin = new URL(apiBaseUrl).origin;
  let addresses;
  async function lookup(hostname, options, callback) {
    try {
      addresses ||= fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`, { headers: { Accept: 'application/dns-json' }, redirect: 'error', signal: AbortSignal.timeout(15_000) })
        .then(async (response) => {
          if (!response.ok) throw new Error('Report API DNS verification failed.');
          const answer = await response.json();
          const ips = (answer.Answer || []).filter((record) => record.type === 1 && isIP(record.data) === 4).map((record) => record.data);
          if (answer.Status !== 0 || !ips.length) throw new Error('The report API address is unavailable.');
          return ips;
        });
      const ips = await addresses;
      if (options?.all) callback(null, ips.map((address) => ({ address, family: 4 })));
      else callback(null, ips[0], 4);
    } catch (error) { callback(error); }
  }
  return async (url, options = {}) => {
    const request = new Request(url, { ...options, redirect: 'error' });
    try { return await fetch(request.clone()); }
    catch (error) {
      if (error.cause?.code !== 'ENOTFOUND' || new URL(url).origin !== origin || new URL(url).protocol !== 'https:') throw error;
    }
    const body = request.body ? Buffer.from(await request.arrayBuffer()) : null;
    return new Promise((resolve, reject) => {
      const outgoing = https.request(url, { method: request.method, headers: Object.fromEntries(request.headers), signal: request.signal, lookup, rejectUnauthorized: true, servername: new URL(url).hostname }, (incoming) => {
        const chunks = []; let length = 0;
        incoming.on('data', (chunk) => {
          length += chunk.length;
          if (length > 1_000_000) { incoming.destroy(new Error('Report response exceeds its permitted size.')); return; }
          chunks.push(chunk);
        });
        incoming.on('error', reject);
        incoming.on('end', () => {
          if (incoming.statusCode >= 300 && incoming.statusCode < 400) { reject(new Error('The report API attempted a redirect.')); return; }
          const bytes = [204, 304].includes(incoming.statusCode) ? null : Buffer.concat(chunks);
          resolve(new Response(bytes, { status: incoming.statusCode, headers: incoming.headers }));
        });
      });
      outgoing.on('error', reject); outgoing.end(body);
    });
  };
}
