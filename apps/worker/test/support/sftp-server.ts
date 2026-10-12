import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import ssh2 from 'ssh2';

const { Server, utils } = ssh2;
const { STATUS_CODE } = utils.sftp;

/**
 * A real SSH server with an SFTP subsystem and `exec`, backed by a local directory.
 * Used to exercise the SFTP/SSH deployment adapter end to end without an external host.
 * Virtual absolute paths ("/srv/site") map under `root`.
 */
export async function startSftpServer(root: string, creds: { username: string; password: string }) {
  const hostKey = utils.generateKeyPairSync('ed25519').private;
  const commands: string[] = [];
  const real = (p: string) => {
    const normal = path.posix.normalize(`/${p}`);
    if (normal.split('/').includes('..')) throw new Error('path escapes root');
    return path.join(root, ...normal.split('/').filter(Boolean));
  };
  const toAttrs = (s: Stats) => ({ mode: s.mode, uid: 0, gid: 0, size: s.size, atime: Math.floor(s.atimeMs / 1000), mtime: Math.floor(s.mtimeMs / 1000) });
  const longname = (name: string, s: Stats) => `${s.isDirectory() ? 'd' : '-'}rwxr-xr-x 1 deploy deploy ${s.size} Jan 01 00:00 ${name}`;

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === creds.username && ctx.password === creds.password) ctx.accept();
      else ctx.reject(['password']);
    });
    client.on('error', () => undefined);
    client.on('ready', () => {
      client.on('session', (acceptSession) => {
        const session = acceptSession();
        session.on('exec', (accept, _reject, info) => {
          const stream = accept();
          commands.push(info.command);
          // The adapter sends: cd '<live>' && <command>
          const m = /^cd '((?:[^']|'\\'')*)' && ([\s\S]+)$/.exec(info.command);
          if (!m) {
            stream.stderr.write('unsupported command\n');
            stream.exit(127);
            stream.end();
            return;
          }
          const child = spawn(m[2]!, { cwd: real(m[1]!.replace(/'\\''/g, "'")), shell: true });
          child.stdout.on('data', (d: Buffer) => stream.write(d));
          child.stderr.on('data', (d: Buffer) => stream.stderr.write(d));
          child.on('close', (code) => {
            stream.exit(code ?? 1);
            stream.end();
          });
        });
        session.on('sftp', (acceptSftp) => {
          const sftp = acceptSftp();
          const handles = new Map<number, { fd?: fs.FileHandle; dir?: string[]; dirPath?: string; done?: boolean }>();
          let next = 1;
          const handle = (h: { fd?: fs.FileHandle; dir?: string[]; dirPath?: string }) => {
            const id = next++;
            handles.set(id, h);
            const b = Buffer.alloc(4);
            b.writeUInt32BE(id);
            return b;
          };
          const get = (b: Buffer) => handles.get(b.readUInt32BE(0));
          const fail = (reqid: number, e: unknown) => sftp.status(reqid, (e as NodeJS.ErrnoException).code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE);
          const run = (reqid: number, fn: () => Promise<void>) => void fn().catch((e) => fail(reqid, e));

          sftp.on('REALPATH', (reqid, p) => {
            const normal = path.posix.normalize(p === '.' ? '/' : `/${p}`);
            sftp.name(reqid, [{ filename: normal, longname: normal, attrs: {} as never }]);
          });
          for (const ev of ['STAT', 'LSTAT'] as const) {
            sftp.on(ev, (reqid, p) => run(reqid, async () => void sftp.attrs(reqid, toAttrs(await fs.stat(real(p))))));
          }
          sftp.on('FSTAT', (reqid, h) => run(reqid, async () => void sftp.attrs(reqid, toAttrs(await get(h)!.fd!.stat()))));
          sftp.on('OPEN', (reqid, filename, flags) =>
            run(reqid, async () => {
              const mode = utils.sftp.flagsToString(flags) ?? 'r';
              const fd = await fs.open(real(filename), mode);
              sftp.handle(reqid, handle({ fd }));
            }),
          );
          sftp.on('WRITE', (reqid, h, offset, data) =>
            run(reqid, async () => {
              await get(h)!.fd!.write(data, 0, data.length, offset);
              sftp.status(reqid, STATUS_CODE.OK);
            }),
          );
          sftp.on('READ', (reqid, h, offset, length) =>
            run(reqid, async () => {
              const buf = Buffer.alloc(length);
              const { bytesRead } = await get(h)!.fd!.read(buf, 0, length, offset);
              if (!bytesRead) sftp.status(reqid, STATUS_CODE.EOF);
              else sftp.data(reqid, buf.subarray(0, bytesRead));
            }),
          );
          sftp.on('CLOSE', (reqid, h) =>
            run(reqid, async () => {
              const entry = get(h);
              handles.delete(h.readUInt32BE(0));
              await entry?.fd?.close();
              sftp.status(reqid, STATUS_CODE.OK);
            }),
          );
          sftp.on('OPENDIR', (reqid, p) =>
            run(reqid, async () => {
              const dir = await fs.readdir(real(p));
              sftp.handle(reqid, handle({ dir, dirPath: real(p) }));
            }),
          );
          sftp.on('READDIR', (reqid, h) =>
            run(reqid, async () => {
              const entry = get(h)!;
              if (entry.done) return void sftp.status(reqid, STATUS_CODE.EOF);
              entry.done = true;
              const items = await Promise.all(
                entry.dir!.map(async (name) => {
                  const s = await fs.stat(path.join(entry.dirPath!, name));
                  return { filename: name, longname: longname(name, s), attrs: toAttrs(s) };
                }),
              );
              sftp.name(reqid, items as never);
            }),
          );
          sftp.on('MKDIR', (reqid, p) =>
            run(reqid, async () => {
              await fs.mkdir(real(p));
              sftp.status(reqid, STATUS_CODE.OK);
            }),
          );
          sftp.on('RMDIR', (reqid, p) =>
            run(reqid, async () => {
              await fs.rmdir(real(p));
              sftp.status(reqid, STATUS_CODE.OK);
            }),
          );
          sftp.on('REMOVE', (reqid, p) =>
            run(reqid, async () => {
              await fs.unlink(real(p));
              sftp.status(reqid, STATUS_CODE.OK);
            }),
          );
          sftp.on('RENAME', (reqid, from, to) =>
            run(reqid, async () => {
              // SFTP v3: renaming onto an existing path fails.
              if (await fs.stat(real(to)).then(() => true, () => false)) return void sftp.status(reqid, STATUS_CODE.FAILURE);
              await fs.rename(real(from), real(to));
              sftp.status(reqid, STATUS_CODE.OK);
            }),
          );
          for (const ev of ['SETSTAT', 'FSETSTAT'] as const) sftp.on(ev, (reqid) => sftp.status(reqid, STATUS_CODE.OK));
        });
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    commands,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
