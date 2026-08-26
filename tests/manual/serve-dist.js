// Minimal static server that reproduces prod's prerendered home for local perf
// probing: "/" → dist/prerendered/index.de.html, everything else from dist/.
const http = require('http');
const fs = require('fs');
const path = require('path');

const DIST = path.join(__dirname, '..', '..', 'dist');
const PORT = process.argv[2] ? Number(process.argv[2]) : 4178;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.woff2': 'font/woff2', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };

http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  let file = urlPath === '/' ? path.join(DIST, 'prerendered', 'index.de.html') : path.join(DIST, urlPath);
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}).listen(PORT, () => console.log(`serving dist on http://localhost:${PORT}/`));
