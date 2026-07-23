// serve.js — minimal static file server, Node standard library only.
//
// The panel loads js/app.js as an ES module, and browsers refuse to resolve
// module imports from a file:// origin. So the directory has to be served over
// HTTP. This exists so that "zero dependencies" stays literally true: node is
// already the only requirement (the test suites are three bare node runs), and
// this pulls nothing from the registry.
//
//   node tools/serve.js            -> http://localhost:8000
//   PORT=9000 node tools/serve.js  -> http://localhost:9000

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PORT = Number(process.env.PORT) || 8000;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';

    // Resolve inside ROOT only — no traversal out of the project directory.
    const target = join(ROOT, normalize(pathname));
    if (target !== ROOT && !target.startsWith(ROOT + sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    const body = await readFile(target);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    }).end(body);
  } catch (err) {
    const code = err.code === 'ENOENT' || err.code === 'EISDIR' ? 404 : 500;
    res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' })
      .end(code === 404 ? 'Not found' : 'Server error');
  }
}).listen(PORT, () => {
  console.log(`Radio Set AN/PRC-77 — serving ${ROOT}`);
  console.log(`  http://localhost:${PORT}`);
});
