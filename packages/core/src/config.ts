import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  APP_URL: z.url(),
  REVIEW_BASE_URL: z.url(),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  PREVIEW_PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  PREVIEW_BASE_DOMAIN: z.string().min(3),
  PREVIEW_PUBLIC_URL_TEMPLATE: z.string().includes('{slug}'),
  PREVIEW_PORT_RANGE: z
    .string()
    .regex(/^\d+-\d+$/)
    .default('41000-41999')
    .transform((v) => {
      const [a, b] = v.split('-').map(Number) as [number, number];
      return { from: a, to: b };
    }),
  DATABASE_URL: z.string().startsWith('postgres'),
  STORAGE_DIR: z.string().min(1),
  APP_ENCRYPTION_KEY: z
    .string()
    .min(1, 'APP_ENCRYPTION_KEY is required (32 random bytes, base64)')
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'APP_ENCRYPTION_KEY must decode to exactly 32 bytes'),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(12),
  COOKIE_SECURE: bool,
  BUILD_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
  BUILD_TIMEOUT_MINUTES: z.coerce.number().int().min(1).max(180).default(20),
  /** Optional defense-in-depth runner for trusted builds. Untrusted sources remain blocked. */
  BUILD_EXECUTOR: z.enum(['host', 'container']).default('host'),
  BUILD_CONTAINER_IMAGE: z.string().min(1).default('node:22-bookworm-slim'),
  BUILD_CONTAINER_CPUS: z.coerce.number().positive().max(16).default(2),
  BUILD_CONTAINER_MEMORY_MB: z.coerce.number().int().min(256).max(32768).default(2048),
  BUILD_CONTAINER_PIDS: z.coerce.number().int().min(32).max(4096).default(256),
  OPENAI_API_KEY: z.string().optional().default(''),
  ANTHROPIC_API_KEY: z.string().optional().default(''),
  /** Self-hosted Ollama runtime. It is never given an external provider key. */
  OLLAMA_BASE_URL: z.url().default('http://127.0.0.1:11434'),
  OLLAMA_MODEL: z.string().min(1).default('qwen2.5-coder:7b'),
  /** Optional local embedding model. Empty keeps the PostgreSQL full-text fallback only. */
  OLLAMA_EMBEDDING_MODEL: z.string().optional().default(''),
  OLLAMA_REQUEST_TIMEOUT_SECONDS: z.coerce.number().int().min(5).max(3600).default(300),
  /**
   * Context window requested from Ollama on every call (num_ctx). Ollama's own default depends on its version and
   * free VRAM and can be as small as 2–4k tokens, which silently truncates the system prompt and tool definitions.
   */
  OLLAMA_CONTEXT_TOKENS: z.coerce.number().int().min(2048).max(262_144).default(16_384),
  /** Optional API gateway / proxy in front of the provider (corporate LLM gateways). Empty = provider default. */
  ANTHROPIC_BASE_URL: z.string().optional().default(''),
  OPENAI_BASE_URL: z.string().optional().default(''),
  OSV_API_URL: z.string().optional().default(''),
  /** Package registries for latest-release lookups of direct dependencies (opt-in via .env; empty = skip, e.g. offline installs). */
  NPM_REGISTRY_URL: z.string().optional().default(''),
  PYPI_URL: z.string().optional().default(''),
  PACKAGIST_URL: z.string().optional().default(''),
  BROWSER_AUTOMATION: bool,
  SMTP_HOST: z.string().optional().default(''),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: z.string().optional().default(''),
  SMTP_PASSWORD: z.string().optional().default(''),
  SMTP_FROM: z.string().optional().default('Project Hub <noreply@localhost>'),
  GIT_BINARY: z.string().default('git'),
  /** Directories the "local" deploy adapter may write to (comma separated). Empty = STORAGE_DIR/deploy-local only. */
  DEPLOY_LOCAL_ROOTS: z.string().optional().default(''),
  PG_DUMP_BINARY: z.string().default('pg_dump'),
});

export type RawConfig = z.infer<typeof configSchema>;
export interface AppConfig extends RawConfig {
  storageDir: string;
  deployLocalRoots: string[];
  encryptionKey: Buffer;
  isProduction: boolean;
}

/** Loads .env (development convenience) and validates the environment. Throws with every problem listed. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, options: { cwd?: string } = {}): AppConfig {
  const cwd = options.cwd ?? findWorkspaceRoot(process.cwd());
  const envFile = path.join(cwd, '.env');
  if (env === process.env && fs.existsSync(envFile) && process.env.NODE_ENV !== 'production') {
    process.loadEnvFile(envFile);
  }
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  const c = parsed.data;
  return {
    ...c,
    storageDir: path.resolve(cwd, c.STORAGE_DIR),
    deployLocalRoots: [path.resolve(cwd, c.STORAGE_DIR, 'deploy-local'), ...c.DEPLOY_LOCAL_ROOTS.split(',').map((x) => x.trim()).filter(Boolean).map((x) => path.resolve(cwd, x))],
    encryptionKey: Buffer.from(c.APP_ENCRYPTION_KEY, 'base64'),
    isProduction: c.NODE_ENV === 'production',
  };
}

/** Walks up from `start` to the directory containing pnpm-workspace.yaml (falls back to start). */
export function findWorkspaceRoot(start: string): string {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}
