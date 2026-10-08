import { Injectable } from '@nestjs/common';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import type { Request } from 'express';
import { eq } from 'drizzle-orm';
import { AppError, detectProject, prettifyName, slugify, walkFiles } from '@projecthub/core';
import { uploads } from '@projecthub/database';
import { Ctx, type AuthInfo } from '../../infra/context.js';
import { extractProjectZip } from './zip.js';

const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;

@Injectable()
export class UploadsService {
  constructor(private readonly ctx: Ctx) {}

  /**
   * Receives a project archive (raw application/zip body), extracts it into storage and runs Smart Import
   * detection. The upload is consumed by project creation; unused uploads expire after 24 h.
   */
  async receive(auth: AuthInfo, req: Request, fileName: string) {
    const length = Number(req.headers['content-length'] ?? 0);
    if (length > MAX_UPLOAD_BYTES) throw new AppError('PAYLOAD_TOO_LARGE', 'Dosya en fazla 300 MB olabilir');
    const id = crypto.randomUUID();
    const dirKey = this.ctx.storage.uploadKey(id);
    const dir = await this.ctx.storage.ensureDir(dirKey);
    const zipPath = path.join(dir, 'source.zip');
    const extractDir = path.join(dir, 'files');
    let received = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        received += chunk.length;
        if (received > MAX_UPLOAD_BYTES) cb(new AppError('PAYLOAD_TOO_LARGE', 'Dosya en fazla 300 MB olabilir'));
        else cb(null, chunk);
      },
    });
    try {
      await pipeline(req, limiter, fs.createWriteStream(zipPath));
      const magic = Buffer.alloc(4);
      const fd = await fs.promises.open(zipPath, 'r');
      await fd.read(magic, 0, 4, 0);
      await fd.close();
      if (magic.readUInt32LE(0) !== 0x04034b50) throw new AppError('VALIDATION_ERROR', 'Yüklenen dosya ZIP biçiminde değil');
      await fs.promises.mkdir(extractDir, { recursive: true });
      const extracted = await extractProjectZip(zipPath, extractDir);
      await fs.promises.rm(zipPath, { force: true });
      const paths = await walkFiles(extractDir);
      const baseName = fileName.replace(/\.zip$/i, '') || extracted.root || 'proje';
      const detection = await detectProject(
        {
          paths,
          read: async (p) => {
            try {
              const full = path.join(extractDir, p);
              const st = await fs.promises.stat(full);
              if (st.size > 512 * 1024) return null;
              return await fs.promises.readFile(full, 'utf8');
            } catch {
              return null;
            }
          },
        },
        extracted.root || baseName,
      );
      await this.ctx.db.insert(uploads).values({
        id,
        organizationId: auth.organizationId,
        userId: auth.user.id,
        fileName: fileName.slice(0, 255),
        storageKey: dirKey,
        sizeBytes: received,
        detection,
        fileCount: extracted.files,
        expiresAt: new Date(Date.now() + 24 * 3600_000),
      });
      return {
        uploadId: id,
        fileCount: extracted.files,
        skipped: extracted.skipped,
        bytes: extracted.bytes,
        detection,
        suggested: { name: prettifyName(detection.name), slug: slugify(detection.name), description: detection.description ?? '' },
        sample: paths.slice(0, 200),
      };
    } catch (e) {
      await this.ctx.storage.remove(dirKey).catch(() => undefined);
      throw e;
    }
  }

  async get(auth: AuthInfo, id: string) {
    const row = (await this.ctx.db.select().from(uploads).where(eq(uploads.id, id)))[0];
    if (!row || row.userId !== auth.user.id) throw new AppError('NOT_FOUND', 'Yükleme bulunamadı');
    return row;
  }
}
