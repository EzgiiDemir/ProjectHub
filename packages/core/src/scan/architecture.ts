import path from 'node:path';
import { sha256 } from '../crypto.js';

export interface ArchitectureAnalysis {
  entryPoints: { path: string; reason: string }[];
  modules: { name: string; files: number }[];
  relationships: { from: string; to: string }[];
  circularDependencies: string[][];
  highCoupling: { path: string; outgoing: number; incoming: number }[];
  duplicates: { lines: number; locations: { path: string; line: number }[] }[];
  configFiles: string[];
  migrationFiles: string[];
  testFrameworks: string[];
}

const SOURCE = /\.(?:[cm]?[jt]sx?|py|php|go|java|cs)$/i;
const ENTRY = /(^|\/)(?:index|main|server|app|cli|manage|program|bootstrap)\.(?:[cm]?[jt]sx?|py|php|go|java|cs)$/i;
const CONFIG = /(^|\/)(?:Dockerfile[^/]*|compose\.ya?ml|docker-compose\.ya?ml|package\.json|tsconfig[^/]*\.json|vite\.config\.[^/]+|next\.config\.[^/]+|pyproject\.toml|requirements[^/]*\.txt|composer\.json|go\.mod|pom\.xml|build\.gradle|projecthub\.yml)$/i;
const MIGRATION = /(^|\/)(?:migrations?|prisma\/migrations|database\/migrations|db\/migrations)\//i;

function moduleName(file: string): string {
  const parts = file.split('/');
  if (parts[0] === 'src' || parts[0] === 'app' || parts[0] === 'packages' || parts[0] === 'apps') return parts.slice(0, Math.min(parts.length - 1, 2)).join('/') || parts[0]!;
  return parts.length > 1 ? parts[0]! : '(root)';
}

function resolveImport(from: string, specifier: string, files: Set<string>): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  const candidates = [base, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py'].map((ext) => `${base}${ext}`), ...['index.ts', 'index.tsx', 'index.js', '__init__.py'].map((name) => `${base}/${name}`)];
  return candidates.find((candidate) => files.has(candidate)) ?? null;
}

function importsOf(file: string, content: string, files: Set<string>): string[] {
  const specs: string[] = [];
  for (const pattern of [/\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g, /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g]) {
    for (const match of content.matchAll(pattern)) if (match[1]) specs.push(match[1]);
  }
  if (file.endsWith('.py')) {
    for (const match of content.matchAll(/^\s*from\s+([.\w]+)\s+import\s+/gm)) {
      const raw = match[1];
      if (!raw) continue;
      const dots = raw.match(/^\.+/)?.[0].length ?? 0;
      if (!dots) continue;
      const up = '../'.repeat(Math.max(0, dots - 1));
      specs.push(`./${up}${raw.slice(dots).replaceAll('.', '/')}`);
    }
  }
  return [...new Set(specs.map((specifier) => resolveImport(file, specifier, files)).filter((value): value is string => !!value))];
}

function cycles(edges: Map<string, Set<string>>): string[][] {
  const found = new Map<string, string[]>();
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const walk = (node: string) => {
    if (visiting.has(node)) {
      const start = stack.indexOf(node);
      const cycle = [...stack.slice(start), node];
      const canonical = cycle.slice(0, -1).sort().join('|');
      if (!found.has(canonical)) found.set(canonical, cycle);
      return;
    }
    if (visited.has(node) || found.size >= 20) return;
    visiting.add(node);
    stack.push(node);
    for (const next of edges.get(node) ?? []) walk(next);
    stack.pop();
    visiting.delete(node);
    visited.add(node);
  };
  for (const node of edges.keys()) walk(node);
  return [...found.values()];
}

/** Deterministic, local architecture signals used before any model interpretation. */
export function analyseArchitecture(input: Map<string, string>): ArchitectureAnalysis {
  const paths = [...input.keys()].sort();
  const files = new Set(paths);
  const sourcePaths = paths.filter((file) => SOURCE.test(file));
  const edges = new Map<string, Set<string>>();
  const incoming = new Map<string, number>();
  for (const file of sourcePaths) {
    const dependencies = new Set(importsOf(file, input.get(file) ?? '', files));
    edges.set(file, dependencies);
    for (const dependency of dependencies) incoming.set(dependency, (incoming.get(dependency) ?? 0) + 1);
  }
  const relationships = [...edges.entries()].flatMap(([from, targets]) => [...targets].map((to) => ({ from, to })));
  const modules = new Map<string, number>();
  for (const file of sourcePaths) modules.set(moduleName(file), (modules.get(moduleName(file)) ?? 0) + 1);

  const duplicateWindows = new Map<string, { path: string; line: number }[]>();
  for (const file of sourcePaths) {
    const lines = (input.get(file) ?? '').split(/\r?\n/);
    for (let index = 0; index + 7 < lines.length; index += 4) {
      const block = lines.slice(index, index + 8).map((line) => line.trim()).filter((line) => line && !/^[{}()[\],;]+$/.test(line)).join('\n');
      if (block.length < 160) continue;
      const hash = sha256(block.replace(/\s+/g, ' '));
      duplicateWindows.set(hash, [...(duplicateWindows.get(hash) ?? []), { path: file, line: index + 1 }]);
    }
  }
  const duplicates = [...duplicateWindows.values()]
    .map((locations) => ({ lines: 8, locations: locations.filter((location, index) => locations.findIndex((candidate) => candidate.path === location.path) === index) }))
    .filter((item) => item.locations.length > 1)
    .slice(0, 10);

  const packageJson = input.get('package.json') ?? '';
  const testFrameworks = [
    /vitest/i.test(packageJson) ? 'Vitest' : null,
    /jest/i.test(packageJson) ? 'Jest' : null,
    /playwright/i.test(packageJson) || paths.some((file) => /playwright\.config\./.test(file)) ? 'Playwright' : null,
    /pytest/i.test(input.get('pyproject.toml') ?? '') || paths.some((file) => /(^|\/)test_.+\.py$/.test(file)) ? 'pytest' : null,
    paths.some((file) => /_test\.go$/.test(file)) ? 'Go test' : null,
    paths.some((file) => /(^|\/)phpunit\.xml/.test(file)) ? 'PHPUnit' : null,
  ].filter((value): value is string => !!value);

  return {
    entryPoints: paths.filter((file) => ENTRY.test(file)).slice(0, 30).map((file) => ({ path: file, reason: 'Yaygın uygulama giriş dosyası adı' })),
    modules: [...modules.entries()].map(([name, count]) => ({ name, files: count })).sort((a, b) => b.files - a.files).slice(0, 30),
    relationships: relationships.slice(0, 500),
    circularDependencies: cycles(edges),
    highCoupling: sourcePaths
      .map((file) => ({ path: file, outgoing: edges.get(file)?.size ?? 0, incoming: incoming.get(file) ?? 0 }))
      .filter((item) => item.outgoing + item.incoming >= 4)
      .sort((a, b) => b.outgoing + b.incoming - (a.outgoing + a.incoming))
      .slice(0, 20),
    duplicates,
    configFiles: paths.filter((file) => CONFIG.test(file)).slice(0, 50),
    migrationFiles: paths.filter((file) => MIGRATION.test(file)).slice(0, 100),
    testFrameworks,
  };
}
