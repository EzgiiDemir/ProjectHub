import { sha256 } from '../crypto.js';
import { scanCode } from './code.js';
import { scanConfig } from './config.js';
import { parseDependencies, scanDependencies } from './dependencies.js';
import { scanSecrets } from './secrets.js';
import { isScannable, type RawFinding } from './types.js';

export * from './types.js';
export * from './secrets.js';
export * from './code.js';
export * from './config.js';
export * from './dependencies.js';
export * from './migrations.js';
export * from './codeindex.js';
export * from './score.js';

export interface RepositorySnapshot {
  files: { path: string; size: number | null }[];
  read(path: string): Promise<string | null>;
}

export interface RepositoryScanResult {
  findings: (RawFinding & { fingerprint: string })[];
  filesScanned: number;
  packagesScanned: number;
  notes: string[];
}

const DEPENDENCY_FILES = ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'composer.lock', 'requirements.txt', 'go.mod', 'Cargo.lock'];

/** Runs every scanner over a repository snapshot (one commit). */
export async function scanRepository(
  snap: RepositorySnapshot,
  opts: { secretScan: boolean; dependencyScan: boolean; osvUrl: string; fetchImpl?: typeof fetch; checkOutdated?: boolean },
): Promise<RepositoryScanResult> {
  const findings: RawFinding[] = [];
  const configFiles = new Map<string, string>();
  let filesScanned = 0;
  for (const f of snap.files) {
    const isConfig = /(^|\/)Dockerfile[^/]*$/.test(f.path) || f.path === '.gitignore' || f.path === 'package.json';
    const isEnv = /(^|\/)\.env(\.[a-z]+)?$/i.test(f.path);
    if (!isScannable(f.path, f.size) && !isConfig && !isEnv) continue;
    const content = await snap.read(f.path);
    if (content === null || content.includes('\u0000')) continue;
    filesScanned++;
    if (isConfig) configFiles.set(f.path, content);
    if (opts.secretScan) findings.push(...scanSecrets(f.path, content));
    findings.push(...scanCode(f.path, content));
  }
  findings.push(...scanConfig(snap.files.map((f) => f.path), configFiles));

  let packagesScanned = 0;
  const notes: string[] = [];
  if (opts.dependencyScan) {
    const depFiles = new Map<string, string>();
    for (const name of DEPENDENCY_FILES) {
      if (!snap.files.some((f) => f.path === name)) continue;
      const c = await snap.read(name);
      if (c !== null) depFiles.set(name, c);
    }
    const deps = parseDependencies(depFiles);
    const r = await scanDependencies(deps, { osvUrl: opts.osvUrl, fetchImpl: opts.fetchImpl, checkOutdated: opts.checkOutdated });
    findings.push(...r.findings);
    packagesScanned = r.packagesScanned;
    notes.push(...r.notes);
  }

  // Deduplicate by fingerprint (the same issue may be matched twice on one line by overlapping rules).
  const unique = new Map<string, RawFinding & { fingerprint: string }>();
  for (const f of findings) {
    const fingerprint = sha256(`${f.ruleId}|${f.identity}`);
    if (!unique.has(fingerprint)) unique.set(fingerprint, { ...f, fingerprint });
  }
  return { findings: [...unique.values()], filesScanned, packagesScanned, notes };
}
