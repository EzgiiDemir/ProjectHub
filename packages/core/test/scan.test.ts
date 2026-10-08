import { describe, expect, it } from 'vitest';
import { decryptFromString, encryptToString, hashPassword, randomToken, verifyPassword } from '../src/crypto.js';
import { detectProject, manifestFromDetection, parseManifest, serializeManifest, slugify } from '../src/manifest.js';
import { scan } from '../src/index.js';

const src = (files: Record<string, string>) => ({
  paths: Object.keys(files),
  read: async (p: string) => files[p] ?? null,
});

describe('project detection', () => {
  it('detects a Next.js + Prisma + PostgreSQL project', async () => {
    const det = await detectProject(
      src({
        'package.json': JSON.stringify({
          name: 'bayi-portali',
          version: '1.3.0',
          scripts: { dev: 'next dev', build: 'next build', start: 'next start', test: 'vitest run' },
          dependencies: { next: '16.0.0', react: '19.0.0', '@prisma/client': '6.0.0', ioredis: '5.4.0' },
          devDependencies: { typescript: '5.0.0', prisma: '6.0.0' },
        }),
        'package-lock.json': '{}',
        'prisma/schema.prisma': 'datasource db { provider = "postgresql" }',
        '.env.example': 'DATABASE_URL=\nREDIS_URL=\nAPP_URL=\n',
        'src/app/page.test.tsx': '',
      }),
      'fallback',
    );
    expect(det).toMatchObject({
      name: 'bayi-portali',
      version: '1.3.0',
      database: 'postgresql',
      installCommand: 'npm ci',
      buildCommand: 'npm run build',
      startCommand: 'npm run start',
      testCommand: 'npm test',
      previewMode: 'process',
      migrationDirectory: 'prisma/migrations',
      envVars: ['DATABASE_URL', 'REDIS_URL', 'APP_URL'],
    });
    expect(det.technologies).toEqual(expect.arrayContaining(['Next.js', 'React', 'TypeScript', 'Prisma', 'Redis']));
    const manifest = manifestFromDetection(det, 'bayi-portali');
    const roundTrip = parseManifest(serializeManifest(manifest));
    expect(roundTrip.start?.port).toBe(3000);
    expect(roundTrip.database.migrate?.directory).toBe('prisma/migrations');
  });

  it('detects a Vite SPA as a static preview', async () => {
    const det = await detectProject(
      src({ 'package.json': JSON.stringify({ scripts: { build: 'vite build' }, dependencies: { react: '19' }, devDependencies: { vite: '7' } }), 'pnpm-lock.yaml': '' }),
      'x',
    );
    expect(det).toMatchObject({ previewMode: 'static', buildOutput: 'dist', installCommand: 'pnpm install --frozen-lockfile', buildCommand: 'pnpm run build' });
  });

  it('detects a plain static site and Laravel', async () => {
    expect(await detectProject(src({ 'index.html': '<h1>x</h1>', 'style.css': '' }), 'site')).toMatchObject({ previewMode: 'static', buildOutput: '.', projectType: 'Statik site' });
    const laravel = await detectProject(src({ 'composer.json': '{"require":{"php":"^8.2","laravel/framework":"^11.0"}}', '.env.example': 'DB_CONNECTION=mysql\n' }), 'l');
    expect(laravel).toMatchObject({ database: 'mysql', migrationDirectory: 'database/migrations', migrateCommand: 'php artisan migrate --force' });
  });

  it('slugifies Turkish names', () => {
    expect(slugify('Ödeme Portalı 2024')).toBe('odeme-portali-2024');
    expect(slugify('Saha Servis Uygulaması')).toBe('saha-servis-uygulamasi');
  });
});

describe('scanners', () => {
  it('finds secrets but ignores examples and env lookups', () => {
    const f = scan.scanSecrets('src/lib/config.ts', [
      'export const a = "AKIA' + 'ABCDEFGHIJKLMNOP";',
      'const stripe = "sk_live_' + '51NxQ2abcdEFGHijklMNOP";',
      'const password = process.env.DB_PASSWORD;',
      'const apiKey = "your-api-key-here";',
      'const url = "postgres://app:S3cr3tPassw0rd@db:5432/app";',
    ].join('\n'));
    expect(f.map((x) => x.ruleId)).toEqual(['secret/aws-access-key', 'secret/stripe-live-key', 'secret/database-url-password']);
    expect(f.every((x) => !x.description.includes('51NxQ2abcdEFGHijklMNOP'))).toBe(true);
    expect(scan.scanSecrets('.env.example', 'STRIPE=sk_live_' + '51NxQ2abcdEFGHijklMNOP')).toEqual([]);
  });

  it('flags SQL injection and command injection', () => {
    const f = scan.scanCode('src/db.ts', 'await db.query(`SELECT * FROM users WHERE id = ${req.params.id}`);\nexec(`convert ${input}`);');
    expect(f.map((x) => x.ruleId)).toEqual(['code/js-sql-injection', 'code/js-command-injection']);
  });

  it('classifies migration risk', () => {
    expect(scan.analyseMigration('m/1.sql', 'ALTER TABLE customers ADD COLUMN status text;').risk).toBe('low');
    expect(scan.analyseMigration('m/2.sql', 'CREATE INDEX customers_status_idx ON customers(status);').risk).toBe('medium');
    expect(scan.analyseMigration('m/3.sql', 'ALTER TABLE users DROP COLUMN phone;').risk).toBe('high');
    expect(scan.analyseMigration('m/4.sql', 'ALTER TABLE t ADD COLUMN x int NOT NULL;').risk).toBe('high');
  });

  it('parses lockfiles', () => {
    const deps = scan.parseDependencies(
      new Map([
        ['package.json', JSON.stringify({ dependencies: { lodash: '^4.17.0' } })],
        ['package-lock.json', JSON.stringify({ packages: { '': {}, 'node_modules/lodash': { version: '4.17.20' }, 'node_modules/@scope/x/node_modules/y': { version: '1.0.0' } } })],
        ['requirements.txt', 'Django==4.2.1\nrequests>=2\n'],
      ]),
    );
    expect(deps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'lodash', version: '4.17.20', direct: true, approximate: false }),
        expect.objectContaining({ name: 'y', version: '1.0.0' }),
        expect.objectContaining({ name: 'django', version: '4.2.1', ecosystem: 'PyPI' }),
      ]),
    );
  });

  it('computes CVSS v3 base scores', () => {
    expect(scan.cvss3BaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H')).toBe(9.8);
    expect(scan.cvss3BaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N')).toBe(6.1);
  });

  it('scores security: any critical caps the score below 50', () => {
    expect(scan.securityScore([]).score).toBe(100);
    expect(scan.securityScore([{ severity: 'critical', type: 'secret' }]).score).toBeLessThan(50);
  });
});

describe('crypto', () => {
  it('encrypts, hashes and generates tokens', async () => {
    const key = Buffer.alloc(32, 7);
    expect(decryptFromString(key, encryptToString(key, 'gizli değer'))).toBe('gizli değer');
    expect(() => decryptFromString(Buffer.alloc(32, 8), encryptToString(key, 'x'))).toThrow();
    const t = randomToken(32);
    expect(t).toMatch(/^[A-Za-z0-9]{32}$/);
    const h = await hashPassword('correct horse 123');
    expect(await verifyPassword(h, 'correct horse 123')).toBe(true);
    expect(await verifyPassword(h, 'wrong')).toBe(false);
  });
});
