import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const src = path.join(root, 'src');
const dist = path.join(root, 'dist');
await fs.rm(dist, { recursive: true, force: true });
await fs.mkdir(dist, { recursive: true });
let count = 0;
for (const f of await fs.readdir(src)) {
  if (!/\.(html|css)$/.test(f)) continue;
  await fs.copyFile(path.join(src, f), path.join(dist, f));
  count++;
}
console.log(`Built ${count} files into dist/`);
