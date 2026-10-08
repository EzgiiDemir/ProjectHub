import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import { AppError } from '@projecthub/core';

/** Folders that are never imported: dependencies, VCS metadata, build output, IDE state. */
export const IMPORT_SKIP_DIR =
  /(^|\/)(node_modules|\.git|\.svn|\.hg|vendor|\.next|\.nuxt|\.output|\.svelte-kit|\.turbo|\.cache|dist|build|out|coverage|__pycache__|\.venv|venv|\.idea|\.vscode|\.DS_Store|obj|target)(\/|$)/;

export interface ExtractResult {
  files: number;
  skipped: number;
  bytes: number;
  root: string;
}

const LIMITS = { maxFiles: 25_000, maxBytes: 1024 * 1024 * 1024, maxFileBytes: 100 * 1024 * 1024 };

/**
 * Extracts a project archive into `dest`. Protects against zip-slip, zip bombs and absurd file counts,
 * skips dependency/build folders, and strips a single common root folder ("project-main/…").
 */
export async function extractProjectZip(zipPath: string, dest: string): Promise<ExtractResult> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true, strictFileNames: false, validateEntrySizes: true }, (err, z) =>
      err || !z ? reject(new AppError('VALIDATION_ERROR', `ZIP dosyası okunamadı: ${err?.message ?? 'bilinmeyen hata'}`)) : resolve(z),
    ),
  );
  const entries: yauzl.Entry[] = [];
  await new Promise<void>((resolve, reject) => {
    zip.on('entry', (e: yauzl.Entry) => {
      entries.push(e);
      if (entries.length > LIMITS.maxFiles * 2) {
        zip.close();
        reject(new AppError('PAYLOAD_TOO_LARGE', 'ZIP çok fazla dosya içeriyor'));
        return;
      }
      zip.readEntry();
    });
    zip.on('end', () => resolve());
    zip.on('error', (e: Error) => reject(new AppError('VALIDATION_ERROR', `ZIP okunamadı: ${e.message}`)));
    zip.readEntry();
  });

  const names = entries.filter((e) => !e.fileName.endsWith('/')).map((e) => e.fileName.replace(/\\/g, '/'));
  const firstSegments = new Set(names.map((n) => n.split('/')[0]));
  const root = firstSegments.size === 1 && names.every((n) => n.includes('/')) ? [...firstSegments][0]! : '';

  // Re-open to stream contents (lazy iteration closed the first handle).
  const zip2 = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true, strictFileNames: false, validateEntrySizes: true }, (err, z) =>
      err || !z ? reject(err) : resolve(z),
    ),
  );
  const result: ExtractResult = { files: 0, skipped: 0, bytes: 0, root };
  const destRoot = path.resolve(dest);
  await new Promise<void>((resolve, reject) => {
    zip2.on('entry', async (entry: yauzl.Entry) => {
      try {
        let name = entry.fileName.replace(/\\/g, '/');
        if (root && name.startsWith(`${root}/`)) name = name.slice(root.length + 1);
        const isDir = name.endsWith('/');
        const isSymlink = ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000;
        if (!name || isDir || isSymlink || IMPORT_SKIP_DIR.test(name) || name.split('/').includes('..')) {
          if (!isDir && name) result.skipped++;
          zip2.readEntry();
          return;
        }
        if (entry.uncompressedSize > LIMITS.maxFileBytes) {
          result.skipped++;
          zip2.readEntry();
          return;
        }
        result.bytes += entry.uncompressedSize;
        if (result.bytes > LIMITS.maxBytes || result.files >= LIMITS.maxFiles) {
          zip2.close();
          reject(new AppError('PAYLOAD_TOO_LARGE', 'Proje çok büyük (en fazla 1 GB ve 25.000 dosya)'));
          return;
        }
        const target = path.resolve(destRoot, name);
        if (!target.startsWith(destRoot + path.sep)) {
          result.skipped++;
          zip2.readEntry();
          return;
        }
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        const stream = await new Promise<NodeJS.ReadableStream>((res, rej) => zip2.openReadStream(entry, (e, s) => (e || !s ? rej(e) : res(s))));
        await pipeline(stream, fs.createWriteStream(target));
        result.files++;
        zip2.readEntry();
      } catch (e) {
        zip2.close();
        reject(e);
      }
    });
    zip2.on('end', () => resolve());
    zip2.on('error', (e: Error) => reject(new AppError('VALIDATION_ERROR', `ZIP okunamadı: ${e.message}`)));
    zip2.readEntry();
  });
  if (!result.files) throw new AppError('VALIDATION_ERROR', 'ZIP içinde içe aktarılabilecek dosya bulunamadı');
  return result;
}
