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
  OPENAI_API_KEY: z.string().optional().default(''),
  ANTHROPIC_API_KEY: z.string().optional().default(''),
  OSV_API_URL: z.string().optional().default(''),
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
