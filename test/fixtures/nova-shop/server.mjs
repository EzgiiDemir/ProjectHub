import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cartTotal } from './src/cart.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');
const port = Number(process.env.PORT ?? 3000);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', version: process.env.npm_package_version ?? '1.2.0' }));
  }
  if (url.pathname === '/api/cart') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ items: [{ name: 'Seramik kupa', price: 209, qty: 2 }], total: cartTotal([{ price: 209, qty: 2 }]) }));
  }
  const pages = { '/': 'index.html', '/products/14': 'product.html', '/checkout': 'checkout.html' };
  const file = pages[url.pathname] ?? url.pathname.slice(1);
  try {
    const full = path.join(dist, path.normalize(file));
    if (!full.startsWith(dist)) throw new Error('outside');
    const body = await fs.readFile(full);
    res.writeHead(200, { 'content-type': types[path.extname(full)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Sayfa bulunamadı');
  }
});

server.listen(port, () => console.log(`Nova Mağaza listening on ${port}`));
