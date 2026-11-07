import http from 'node:http';
import { Readable } from 'node:stream';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, sep, extname } from 'node:path';
import worker from '../worker/index.mjs';
import { database } from './database.mjs';

const root = fileURLToPath(new URL('../public/', import.meta.url));
const data = fileURLToPath(new URL('../local-data/', import.meta.url));
await mkdir(data, { recursive: true });
const db = database(resolve(data, 'reports.sqlite'));
const port = Number(process.env.REPORT_PORT || 8897);
const origin = `http://127.0.0.1:${port}`;
const env = { DB: db, LOCAL_DEVELOPMENT: 'true', ALLOWED_ORIGIN: origin, ADMIN_TOKEN: process.env.REPORT_ADMIN_TOKEN || 'local-preview-only' };
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.otf': 'font/otf' };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, origin);
    if (url.pathname === '/reports' || url.pathname.startsWith('/reports/')) {
      const request = new Request(url, { method: req.method, headers: req.headers, ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: Readable.toWeb(req), duplex: 'half' }) });
      const response = await worker.fetch(request, env);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) Readable.fromWeb(response.body).pipe(res); else res.end();
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
    const path = resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!path.startsWith(root.endsWith(sep) ? root : root + sep)) { res.writeHead(403).end(); return; }
    const content = await readFile(path);
    res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch { res.writeHead(404).end('Not found'); }
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Report page: ${origin}`);
  console.log(`Developer inbox: ${origin}/inbox.html`);
  console.log('Local access key: use REPORT_ADMIN_TOKEN, or the documented local-preview-only default.');
  console.log(`Reports persist in ${data}`);
});
function stop() { server.close(() => { db.close(); process.exit(0); }); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
