/** Splits source files into overlapping line windows and extracts symbols for the code index. */

export interface Chunk {
  startLine: number;
  endLine: number;
  content: string;
}

const INDEXABLE =
  /\.(js|mjs|cjs|ts|mts|cts|tsx|jsx|vue|svelte|astro|php|py|rb|go|java|kt|cs|rs|swift|dart|sql|prisma|graphql|md|mdx|ya?ml|toml|json|css|scss|html?|sh)$|(^|\/)(Dockerfile|Makefile|README[^/]*)$/i;
const SKIP =
  /(^|\/)(node_modules|vendor|\.git|dist|build|out|\.next|\.nuxt|coverage|__pycache__|\.venv|target|bin|obj|public\/build)(\/|$)|(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|composer\.lock|Cargo\.lock|\.min\.js|\.map)$/i;

export function isIndexable(path: string, size: number | null): boolean {
  return INDEXABLE.test(path) && !SKIP.test(path) && (size ?? 0) <= 300 * 1024;
}

export function languageOf(path: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    vue: 'vue', svelte: 'svelte', astro: 'astro', php: 'php', py: 'python', rb: 'ruby', go: 'go',
    java: 'java', kt: 'kotlin', cs: 'csharp', rs: 'rust', swift: 'swift', dart: 'dart', sql: 'sql',
    prisma: 'prisma', graphql: 'graphql', md: 'markdown', mdx: 'markdown', yml: 'yaml', yaml: 'yaml',
    toml: 'toml', json: 'json', css: 'css', scss: 'scss', html: 'html', htm: 'html', sh: 'shell',
  };
  if (/(^|\/)Dockerfile$/.test(path)) return 'dockerfile';
  return map[ext] ?? 'text';
}

export function chunkFile(content: string, size = 60, overlap = 10): Chunk[] {
  const lines = content.split(/\r?\n/);
  const chunks: Chunk[] = [];
  for (let start = 0; start < lines.length; start += size - overlap) {
    const end = Math.min(lines.length, start + size);
    const text = lines.slice(start, end).join('\n');
    if (text.trim()) chunks.push({ startLine: start + 1, endLine: end, content: text });
    if (end === lines.length) break;
  }
  return chunks;
}

const SYMBOL_PATTERNS: RegExp[] = [
  /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g,
  /\b(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g,
  /\b(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
  /\bexport\s+const\s+([A-Za-z_$][\w$]*)/g,
  /^\s*def\s+([A-Za-z_]\w*)/gm,
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm,
  /\bmodel\s+([A-Z]\w*)\s*\{/g,
  /\b(?:public|private|protected)\s+function\s+([A-Za-z_]\w*)/g,
  /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([A-Za-z_][\w.]*)/gi,
];

export function extractSymbols(content: string): string[] {
  const out = new Set<string>();
  for (const re of SYMBOL_PATTERNS) {
    re.lastIndex = 0;
    for (const m of content.matchAll(re)) {
      if (m[1] && m[1].length > 1) out.add(m[1]);
      if (out.size >= 200) break;
    }
  }
  return [...out];
}

export interface CodeStats {
  todo: number;
  largeFiles: number;
  longFunctions: number;
  testFiles: number;
  sourceFiles: number;
  hasReadme: boolean;
}

const TEST_FILE = /(\.|_)(test|spec)\.[cm]?[jt]sx?$|(^|\/)__tests__\/|(^|\/)tests?\/.+\.(py|php|go|java|cs)$|_test\.go$/;

/** Technical-debt signals collected while indexing. */
export function accumulateStats(stats: CodeStats, path: string, content: string): void {
  if (TEST_FILE.test(path)) stats.testFiles++;
  if (/^readme(\.|$)/i.test(path.split('/').pop() ?? '') && !path.includes('/')) stats.hasReadme = true;
  if (!/\.(js|mjs|cjs|ts|tsx|jsx|vue|svelte|php|py|go|java|kt|cs|rs|rb)$/i.test(path)) return;
  stats.sourceFiles++;
  stats.todo += (content.match(/\b(TODO|FIXME|HACK|XXX)\b/g) ?? []).length;
  const lines = content.split(/\r?\n/);
  if (lines.length > 500) stats.largeFiles++;
  // Long functions: function headers whose next sibling-or-lower-indented closing brace is > 80 lines away.
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (!/(function\b|=>\s*\{|\bdef\s|\bfunc\s|\)\s*\{\s*$)/.test(l) || !/\{\s*$|:\s*$/.test(l)) continue;
    const indent = /^\s*/.exec(l)![0].length;
    let j = i + 1;
    while (j < lines.length && (lines[j]!.trim() === '' || /^\s*/.exec(lines[j]!)![0].length > indent)) j++;
    if (j - i > 80) {
      stats.longFunctions++;
      i = j;
    }
  }
}

export function emptyStats(): CodeStats {
  return { todo: 0, largeFiles: 0, longFunctions: 0, testFiles: 0, sourceFiles: 0, hasReadme: false };
}
