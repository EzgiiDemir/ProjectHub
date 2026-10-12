import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyDir, moveDir } from '../src/index.js';

/** A workspace with a Turbopack-style server external link: absolute junction on Windows, relative symlink elsewhere. */
async function workspace(tmp: string) {
  const src = path.join(tmp, 'workspace');
  await fs.mkdir(path.join(src, 'node_modules', 'pg'), { recursive: true });
  await fs.writeFile(path.join(src, 'node_modules', 'pg', 'index.js'), 'module.exports = 1;');
  await fs.mkdir(path.join(src, '.next', 'node_modules'), { recursive: true });
  const link = path.join(src, '.next', 'node_modules', 'pg-b1376c1eb08f9ce3');
  if (process.platform === 'win32') await fs.symlink(path.join(src, 'node_modules', 'pg'), link, 'junction');
  else await fs.symlink('../../node_modules/pg', link);
  return src;
}

describe('moveDir (process artifacts are moved, not copied)', () => {
  it('re-points links that pointed into the old location', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ph-move-'));
    const src = await workspace(tmp);
    const dest = path.join(tmp, 'artifact');
    await moveDir(src, dest);
    await expect(fs.access(src)).rejects.toThrow();
    const moved = path.join(dest, '.next', 'node_modules', 'pg-b1376c1eb08f9ce3');
    expect(await fs.readFile(path.join(moved, 'index.js'), 'utf8')).toBe('module.exports = 1;');
    expect(path.resolve(path.dirname(moved), (await fs.readlink(moved)).replace(/^\\\\\?\\/, ''))).toBe(path.join(dest, 'node_modules', 'pg'));
    await fs.rm(tmp, { recursive: true, force: true });
  });
});

describe('copyDir (build workspace → artifact)', () => {
  it('keeps links into the copied tree valid after the source is deleted (Turbopack server externals)', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ph-copy-'));
    const src = path.join(tmp, 'workspace');
    const dest = path.join(tmp, 'artifact');
    await fs.mkdir(path.join(src, 'node_modules', 'pg'), { recursive: true });
    await fs.writeFile(path.join(src, 'node_modules', 'pg', 'index.js'), 'module.exports = 1;');
    await fs.mkdir(path.join(src, '.next', 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(src, 'secret.env'), 'X=1');
    // What Turbopack creates: an absolute junction on Windows, a relative symlink elsewhere.
    const link = path.join(src, '.next', 'node_modules', 'pg-b1376c1eb08f9ce3');
    if (process.platform === 'win32') await fs.symlink(path.join(src, 'node_modules', 'pg'), link, 'junction');
    else await fs.symlink('../../node_modules/pg', link);

    await copyDir(src, dest, (rel) => !rel.endsWith('.env'));
    await fs.rm(src, { recursive: true, force: true });

    const copied = path.join(dest, '.next', 'node_modules', 'pg-b1376c1eb08f9ce3');
    expect(await fs.readFile(path.join(copied, 'index.js'), 'utf8')).toBe('module.exports = 1;');
    expect(path.resolve(path.dirname(copied), (await fs.readlink(copied)).replace(/^\\\\\?\\/, ''))).toBe(path.join(dest, 'node_modules', 'pg'));
    await expect(fs.access(path.join(dest, 'secret.env'))).rejects.toThrow(); // filter still applies
    await fs.rm(tmp, { recursive: true, force: true });
  });
});
