import { z } from 'zod';
import { AI_AUTONOMY_LEVELS } from './enums.js';

/**
 * projecthub.yml — the contract between a managed project and Project Hub.
 * It tells the hub how to install, build, test, preview, migrate and deploy the project.
 */
const command = z.string().trim().min(1).max(2000);

const durationPattern = /^(\d+)(m|h|d)$/;
export const durationSchema = z
  .string()
  .regex(durationPattern, 'Süre "30m", "24h" veya "7d" biçiminde olmalı');

export function durationToMinutes(value: string): number {
  const m = durationPattern.exec(value);
  if (!m) throw new Error(`Invalid duration: ${value}`);
  const n = Number(m[1]);
  return m[2] === 'm' ? n : m[2] === 'h' ? n * 60 : n * 1440;
}

export const RUNTIME_TYPES = ['node', 'python', 'php', 'go', 'java', 'dotnet', 'static', 'other'] as const;

export const manifestSchema = z.object({
  project: z.object({
    name: z.string().trim().min(1).max(150),
    slug: z.string().trim().max(150).optional(),
    version: z.string().trim().max(50).default('0.1.0'),
  }),
  runtime: z
    .object({
      type: z.enum(RUNTIME_TYPES).default('other'),
      version: z.string().trim().max(30).optional(),
    })
    .default({ type: 'other' }),
  install: z.object({ command }).optional(),
  build: z
    .object({
      command: command.optional(),
      /** Directory (relative to repo root) that contains the build output to publish/preview. */
      output: z.string().trim().max(300).optional(),
      timeoutMinutes: z.number().int().min(1).max(120).default(20),
    })
    .optional(),
  test: z.object({ command }).optional(),
  start: z
    .object({
      command,
      port: z.number().int().min(1).max(65535).default(3000),
    })
    .optional(),
  health: z.object({ path: z.string().startsWith('/').default('/') }).default({ path: '/' }),
  database: z
    .object({
      type: z.enum(['postgresql', 'mysql', 'mongodb', 'sqlite', 'none']).default('none'),
      migrate: z
        .object({
          command: command.optional(),
          /** Directory scanned to detect migration files between versions. */
          directory: z.string().trim().max(300).optional(),
        })
        .optional(),
    })
    .default({ type: 'none' }),
  preview: z
    .object({
      enabled: z.boolean().default(true),
      ttl: durationSchema.default('24h'),
      /** static = serve build output; process = run start.command. Auto-detected when omitted. */
      mode: z.enum(['static', 'process']).optional(),
      /** Serve index.html for unknown paths (single page applications). */
      spa: z.boolean().default(false),
    })
    .default({ enabled: true, ttl: '24h', spa: false }),
  deploy: z
    .object({
      /** Directory uploaded by file based adapters (sftp/ftp/local). Defaults to build.output or repo root. */
      source: z.string().trim().max(300).optional(),
      exclude: z.array(z.string().max(200)).max(100).default([]),
    })
    .optional(),
  smoke: z.object({ paths: z.array(z.string().startsWith('/')).max(20).default(['/']) }).optional(),
  env: z
    .array(
      z.object({
        name: z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'Ortam değişkeni adı BÜYÜK_HARF olmalı'),
        required: z.boolean().default(false),
        description: z.string().max(300).optional(),
      }),
    )
    .max(200)
    .default([]),
  security: z
    .object({
      dependencyScan: z.boolean().default(true),
      secretScan: z.boolean().default(true),
    })
    .default({ dependencyScan: true, secretScan: true }),
  ai: z
    .object({
      indexing: z.boolean().default(true),
      autonomy: z.enum(AI_AUTONOMY_LEVELS).default('L2'),
    })
    .default({ indexing: true, autonomy: 'L2' }),
});

export type Manifest = z.infer<typeof manifestSchema>;
export type ManifestInput = z.input<typeof manifestSchema>;

/** Result of automatic project detection (Smart Project Import). */
export interface DetectionResult {
  name: string;
  version: string;
  projectType: string;
  runtime: { type: (typeof RUNTIME_TYPES)[number]; version?: string };
  technologies: string[];
  database: 'postgresql' | 'mysql' | 'mongodb' | 'sqlite' | 'none';
  packageManager?: 'npm' | 'pnpm' | 'yarn' | 'bun' | 'composer' | 'pip' | 'go' | 'maven' | 'gradle' | 'dotnet';
  installCommand?: string;
  buildCommand?: string;
  buildOutput?: string;
  testCommand?: string;
  startCommand?: string;
  port?: number;
  previewMode: 'static' | 'process' | 'none';
  migrationDirectory?: string;
  migrateCommand?: string;
  envVars: string[];
  checks: string[];
  warnings: string[];
  description?: string;
  hasManifest: boolean;
}
