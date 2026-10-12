import { spawn } from 'node:child_process';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import type { INestApplication } from '@nestjs/common';
import { branchProtectionOf, GitRepository, type Actor } from '@projecthub/core';
import { AuthGuard } from '../../infra/auth.guard.js';
import { Ctx, clientIp } from '../../infra/context.js';
import { ProjectAccess } from '../../infra/project-access.js';
import { Repos } from '../../infra/repos.js';
import { RepositoryService } from './repository.service.js';

const PATH_RE = /^\/git\/([0-9a-f-]{36})\.git(\/(?:info\/refs|git-upload-pack|git-receive-pack|HEAD|objects\/.*))$/i;

/**
 * Git Smart HTTP endpoint: `git clone <APP_URL>/git/<projectId>.git`.
 * Authentication: HTTP Basic, password = personal access token (ph_…). Reads need repository.read,
 * pushes need repository.push. Served by `git http-backend`, so the protocol is git's own implementation.
 */
export function gitHttpMiddleware(app: INestApplication) {
  const ctx = app.get(Ctx);
  const guard = app.get(AuthGuard);
  const repos = app.get(Repos);
  const repoService = app.get(RepositoryService);
  const projectAccess = app.get(ProjectAccess);

  return async (req: Request, res: Response, next: NextFunction) => {
    const m = PATH_RE.exec(req.path);
    if (!m) return next();
    const projectId = m[1]!.toLowerCase();
    const isPush = req.path.endsWith('/git-receive-pack') || req.query.service === 'git-receive-pack';
    const challenge = () => {
      res.setHeader('www-authenticate', 'Basic realm="Project Hub"');
      res.status(401).send('Kimlik doğrulama gerekli: kullanıcı adı olarak e-postanızı, şifre olarak kişisel erişim tokeninizi (ph_...) girin.\n');
    };
    try {
      const header = req.headers.authorization;
      if (!header?.startsWith('Basic ')) return challenge();
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      const token = decoded.slice(decoded.indexOf(':') + 1);
      const auth = await guard.authenticate({ headers: { authorization: `Bearer ${token}` } } as Request);
      if (!auth) return challenge();
      const scope = await projectAccess.require(auth, projectId).catch(() => null);
      const needed = isPush ? 'repository.push' : 'repository.read';
      if (!scope || !scope.can(needed) || (isPush && scope.project.status === 'archived')) {
        res.status(403).send('Bu repository için yetkiniz yok.\n');
        return;
      }
      const { git, repo } = await repos.forProject(projectId);
      const before = isPush ? await git.refSnapshot() : null;
      if (isPush) await git.ensureProtectionHook();
      const protectedRefs = isPush ? branchProtectionOf(scope.project.settings).branches.join(' ') : '';
      await runHttpBackend(ctx.config.GIT_BINARY, path.dirname(git.dir), req, res, m[2]!, auth.user.email, protectedRefs);
      if (isPush && before && req.path.endsWith('/git-receive-pack')) {
        const after = await git.refSnapshot();
        const actor: Actor = { type: 'user', id: auth.user.id, label: auth.user.displayName, ip: clientIp(req), userAgent: String(req.headers['user-agent'] ?? '') };
        for (const [ref, sha] of after) {
          if (before.get(ref) === sha || !ref.startsWith('refs/heads/')) continue;
          const branch = ref.slice('refs/heads/'.length);
          const info = await new GitRepository(git.dir, ctx.config.GIT_BINARY).commitInfo(sha);
          await repoService.recordPush(projectId, auth.organizationId, branch, sha, info?.subject ?? 'push', info?.filesChanged ?? 0, actor, repo.id, scope.project.defaultBranch);
        }
      }
    } catch (e) {
      ctx.logger.error({ err: e, projectId }, 'git http request failed');
      if (!res.headersSent) res.status(500).send('Repository işlemi başarısız oldu.\n');
      else res.end();
    }
  };
}

function runHttpBackend(gitBinary: string, root: string, req: Request, res: Response, pathInfoSuffix: string, user: string, protectedRefs = ''): Promise<void> {
  return new Promise((resolve, reject) => {
    const repoName = path.basename(req.path.split('.git')[0]!) + '.git';
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: `/${repoName}${pathInfoSuffix}`,
      REQUEST_METHOD: req.method,
      QUERY_STRING: req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?') + 1) : '',
      CONTENT_TYPE: req.headers['content-type'] ?? '',
      REMOTE_USER: user,
      REMOTE_ADDR: clientIp(req) ?? '',
      GIT_HTTP_MAX_REQUEST_BUFFER: '100M',
      // Read by the pre-receive hook (branch protection).
      PH_PROTECTED_REFS: protectedRefs,
    };
    if (req.headers['content-encoding']) env.HTTP_CONTENT_ENCODING = String(req.headers['content-encoding']);
    if (req.headers['git-protocol']) env.GIT_PROTOCOL = String(req.headers['git-protocol']);
    if (req.headers['content-length']) env.CONTENT_LENGTH = String(req.headers['content-length']);
    const child = spawn(gitBinary, ['-c', 'safe.directory=*', 'http-backend'], { env, windowsHide: true });
    let headerBuf = Buffer.alloc(0);
    let headersDone = false;
    child.stdout.on('data', (chunk: Buffer) => {
      if (headersDone) {
        res.write(chunk);
        return;
      }
      headerBuf = Buffer.concat([headerBuf, chunk]);
      let sep = headerBuf.indexOf('\r\n\r\n');
      let sepLen = 4;
      if (sep < 0) {
        sep = headerBuf.indexOf('\n\n');
        sepLen = 2;
      }
      if (sep < 0) return;
      const head = headerBuf.subarray(0, sep).toString('utf8');
      const body = headerBuf.subarray(sep + sepLen);
      headersDone = true;
      let status = 200;
      for (const line of head.split(/\r?\n/)) {
        const i = line.indexOf(':');
        if (i < 0) continue;
        const k = line.slice(0, i).trim();
        const v = line.slice(i + 1).trim();
        if (k.toLowerCase() === 'status') status = Number.parseInt(v, 10) || 200;
        else res.setHeader(k, v);
      }
      res.removeHeader('x-frame-options');
      res.status(status);
      if (body.length) res.write(body);
    });
    child.stderr.on('data', () => undefined);
    child.on('error', reject);
    child.on('close', () => {
      res.end();
      resolve();
    });
    req.pipe(child.stdin);
  });
}
