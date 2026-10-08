import type { RawFinding } from './types.js';

/** Configuration / container hygiene checks over the file list and selected files. */
export function scanConfig(paths: string[], files: Map<string, string>): RawFinding[] {
  const findings: RawFinding[] = [];
  const set = new Set(paths);

  for (const [p, content] of files) {
    if (!/(^|\/)Dockerfile[^/]*$/.test(p)) continue;
    const lines = content.split(/\r?\n/);
    const froms = lines.map((l, i) => ({ l: l.trim(), i })).filter((x) => /^FROM\s/i.test(x.l));
    for (const f of froms) {
      const image = f.l.split(/\s+/)[1] ?? '';
      if (image !== 'scratch' && !/^\$/.test(image) && (!image.includes(':') || image.endsWith(':latest')) && !image.includes('@sha256')) {
        findings.push({
          type: 'config',
          severity: 'low',
          ruleId: 'config/docker-unpinned-image',
          title: 'Sabitlenmemiş base image',
          description: `${p}:${f.i + 1} "${image}" etiket/sürüm içermiyor. Tekrarlanabilir build için sürüm (ör. node:22-alpine) kullanın.`,
          filePath: p,
          line: f.i + 1,
          identity: `docker-unpinned|${p}|${image}`,
        });
      }
    }
    const userLines = lines.filter((l) => /^USER\s/i.test(l.trim()));
    const lastUser = userLines.at(-1)?.trim().split(/\s+/)[1];
    if (froms.length && (!lastUser || lastUser === 'root' || lastUser === '0')) {
      findings.push({
        type: 'config',
        severity: 'medium',
        ruleId: 'config/docker-root-user',
        title: 'Container root kullanıcısıyla çalışıyor',
        description: `${p} içinde root olmayan bir USER tanımlanmamış. Container ele geçirilirse etki alanı büyür.`,
        filePath: p,
        identity: `docker-root|${p}`,
      });
    }
    lines.forEach((l, i) => {
      if (/^(ENV|ARG)\s+\S*(PASSWORD|SECRET|TOKEN|API_KEY)\S*[\s=]+\S+/i.test(l.trim())) {
        findings.push({
          type: 'config',
          severity: 'high',
          ruleId: 'config/docker-secret-in-image',
          title: 'Image içine gömülü secret',
          description: `${p}:${i + 1} ENV/ARG ile secret tanımlanıyor; image katmanlarında kalıcı olarak saklanır. Çalışma zamanında secret olarak verin.`,
          filePath: p,
          line: i + 1,
          identity: `docker-secret|${p}|${l.trim().split(/[\s=]/)[1]}`,
        });
      }
    });
  }

  const pkg = files.get('package.json');
  if (pkg && !['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'].some((l) => set.has(l))) {
    findings.push({
      type: 'config',
      severity: 'low',
      ruleId: 'config/missing-lockfile',
      title: 'Bağımlılık kilit dosyası yok',
      description: 'Lock dosyası olmadan her kurulum farklı (ve doğrulanmamış) sürümler çekebilir; bağımlılık taraması da yaklaşık sürümlerle yapılır.',
      filePath: 'package.json',
      identity: 'missing-lockfile',
    });
  }

  // Projects that use env files must keep the real one out of version control.
  const usesEnvFiles = paths.some((p) => /(^|\/)\.env(\.example|\.sample)?$/.test(p));
  const gitignore = files.get('.gitignore') ?? '';
  if (usesEnvFiles && !/^\s*\/?\.env(\*|\.\*)?\s*$/m.test(gitignore)) {
    findings.push({
      type: 'config',
      severity: 'low',
      ruleId: 'config/env-not-ignored',
      title: '.env dosyası .gitignore içinde değil',
      description: '.gitignore dosyasına .env ekleyin; aksi halde gerçek değerler yanlışlıkla commit edilebilir.',
      filePath: '.gitignore',
      identity: 'env-not-ignored',
    });
  }
  return findings;
}
