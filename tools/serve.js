/*
 * Server statico per lo sviluppo locale. Serve solo file — niente backend:
 * esattamente come Cube-Atlas. Avvio: npm run serve
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 5174;
const HOST = process.env.HOST || '127.0.0.1';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host}`);
  let rel = decodeURIComponent(parsed.pathname);
  if (rel.endsWith('/')) rel += 'index.html';

  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Non trovato');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Galaxia Live:  http://${HOST}:${PORT}\n`);
});
