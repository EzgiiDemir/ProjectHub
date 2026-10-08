import type { FindingType, Severity } from '@projecthub/contracts';

export interface RawFinding {
  type: FindingType;
  severity: Severity;
  ruleId: string;
  title: string;
  description: string;
  filePath?: string;
  line?: number;
  packageName?: string;
  packageVersion?: string;
  fixedVersion?: string;
  advisoryId?: string;
  references?: string[];
  /** Material used for the stable fingerprint (never the secret itself). */
  identity: string;
}

/** Files that are never scanned for code issues: dependencies, generated output, binaries. */
export const SKIP_PATH =
  /(^|\/)(node_modules|vendor|\.git|dist|build|out|\.next|\.nuxt|\.output|coverage|__pycache__|\.venv|venv|target|bin|obj)(\/|$)|\.(min\.js|map|lock|png|jpe?g|gif|webp|ico|svg|pdf|zip|gz|woff2?|ttf|eot|mp4|mp3|exe|dll|so|dylib|jar|class)$/i;

export const TEXT_FILE =
  /\.(js|mjs|cjs|ts|mts|cts|tsx|jsx|json|md|txt|ya?ml|toml|ini|cfg|conf|env|properties|css|scss|sass|less|html?|vue|svelte|astro|php|py|rb|go|java|kt|kts|cs|xml|sql|prisma|sh|bash|ps1|bat|gradle|graphql|gql|twig|ejs|hbs|rs|swift|dart|tf|tfvars)$|(^|\/)(Dockerfile|Makefile|Procfile|\.env(\..+)?|\.npmrc|\.pypirc|docker-compose[^/]*)$/i;

export function isScannable(path: string, size: number | null): boolean {
  return !SKIP_PATH.test(path) && TEXT_FILE.test(path) && (size ?? 0) <= 512 * 1024;
}
