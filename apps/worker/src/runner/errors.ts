export interface ExtractedError {
  file?: string;
  line?: number;
  message: string;
}

const PATTERNS: { re: RegExp; map: (m: RegExpExecArray, lines: string[], i: number) => ExtractedError }[] = [
  // tsc: src/a.ts(12,5): error TS2339: Property ...
  { re: /^(?:\.\/)?([\w./@-]+\.[cm]?[jt]sx?)\((\d+),\d+\):\s+error\s+(TS\d+:.*)$/, map: (m) => ({ file: m[1], line: Number(m[2]), message: m[3]! }) },
  // tsc --pretty / vue-tsc: src/a.ts:12:5 - error TS2339: ...
  { re: /^(?:\.\/)?([\w./@-]+\.[cm]?[jt]sx?|[\w./@-]+\.vue):(\d+):\d+\s+-\s+error\s+(TS\d+:.*)$/, map: (m) => ({ file: m[1], line: Number(m[2]), message: m[3]! }) },
  // Next.js: ./src/app/page.tsx:12:5  followed by "Type error: ..."
  {
    re: /^\.\/([\w./@\[\]-]+\.[cm]?[jt]sx?):(\d+):\d+$/,
    map: (m, lines, i) => ({ file: m[1], line: Number(m[2]), message: lines.slice(i + 1, i + 4).find((l) => /error/i.test(l))?.trim() ?? lines[i + 1]?.trim() ?? 'Derleme hatası' }),
  },
  // Vite / Rollup
  { re: /\[vite\]:? Rollup failed to resolve import "([^"]+)" from "([^"]+)"/, map: (m) => ({ file: m[2]!.replace(/^.*?\/src\//, 'src/'), message: `Import çözülemedi: ${m[1]}` }) },
  { re: /^(?:ERROR|✘ \[ERROR\])\s+(.*)$/, map: (m, lines, i) => ({ message: m[1]!.trim(), ...fileLine(lines[i + 1] ?? '') }) },
  // Webpack
  { re: /Module not found: (?:Error: )?(.*)$/, map: (m) => ({ message: `Modül bulunamadı: ${m[1]!.trim()}` }) },
  // Node runtime
  { re: /Error: Cannot find module '([^']+)'/, map: (m) => ({ message: `Modül bulunamadı: ${m[1]}` }) },
  // Python traceback (last frame wins: scan from the bottom)
  { re: /^\s*File "([^"]+)", line (\d+)/, map: (m, lines) => ({ file: m[1], line: Number(m[2]), message: lines.filter((l) => /^\w*(Error|Exception)\b/.test(l.trim())).at(-1)?.trim() ?? 'Python hatası' }) },
  // npm
  { re: /^npm (?:ERR!|error) Missing script: "?([\w:-]+)"?/i, map: (m) => ({ message: `package.json içinde "${m[1]}" script'i yok` }) },
  // Test runners
  { re: /^\s*(?:FAIL|×|✗)\s+([\w./@-]+\.(?:test|spec)\.[cm]?[jt]sx?)/, map: (m, lines, i) => ({ file: m[1], message: `Test başarısız: ${lines.slice(i + 1, i + 6).find((l) => /●|›|AssertionError|Expected/.test(l))?.trim() ?? m[1]}` }) },
];

function fileLine(s: string): { file?: string; line?: number } {
  const m = /([\w./@-]+\.[a-z]{1,4}):(\d+)/.exec(s);
  return m ? { file: m[1]!.replace(/^\.\//, ''), line: Number(m[2]) } : {};
}

/** Finds the most useful error in a failed step's output. Never throws. */
export function extractError(lines: string[]): ExtractedError {
  for (let i = 0; i < lines.length; i++) {
    for (const p of PATTERNS) {
      const m = p.re.exec(lines[i]!);
      if (m) {
        const e = p.map(m, lines, i);
        return { ...e, message: e.message.slice(0, 500) };
      }
    }
  }
  const errorLine = [...lines].reverse().find((l) => /\berror\b/i.test(l) && l.trim().length > 6);
  return { message: (errorLine ?? lines.filter((l) => l.trim()).at(-1) ?? 'Komut başarısız oldu').trim().slice(0, 500) };
}
