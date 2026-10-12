/**
 * Starter templates for new projects (spec §129). Each template is a small but complete, buildable project
 * with its projecthub.yml: manifest, build, security, preview and deployment defaults included.
 */
import type { ProjectTemplateId } from '@projecthub/contracts';

export interface ProjectTemplate {
  id: ProjectTemplateId;
  name: string;
  description: string;
  technologies: string[];
  /** Runtime the worker needs for builds and previews. */
  requires: string;
  files: (ctx: { name: string; slug: string }) => Record<string, string>;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const gitignore = (extra: string[] = []) => ['node_modules/', 'dist/', '.next/', '.env', '.env.*', '!.env.example', ...extra, ''].join('\n');

const readme = (name: string, lines: string[]) => [`# ${name}`, '', ...lines, '', 'Bu proje Project Hub şablonundan oluşturuldu. Build, ön izleme ve deployment ayarları `projecthub.yml` içindedir.', ''].join('\n');

export const PROJECT_TEMPLATES: Record<ProjectTemplateId, ProjectTemplate> = {
  static: {
    id: 'static',
    name: 'Statik web sitesi',
    description: 'HTML, CSS ve JavaScript; build adımı yok. Kurumsal site, landing page, kampanya sayfası.',
    technologies: ['HTML/CSS', 'JavaScript'],
    requires: '—',
    files: ({ name, slug }) => ({
      'index.html': `<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(name)}</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <header class="top"><strong>${esc(name)}</strong><nav><a href="index.html">Ana sayfa</a><a href="iletisim.html">İletişim</a></nav></header>
  <main>
    <section class="hero">
      <h1>${esc(name)}</h1>
      <p>Bu sayfayı düzenleyerek başlayın.</p>
      <a class="cta" href="iletisim.html">Bize ulaşın</a>
    </section>
  </main>
  <script src="app.js"></script>
</body>
</html>
`,
      'iletisim.html': `<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>İletişim · ${esc(name)}</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <header class="top"><strong>${esc(name)}</strong><nav><a href="index.html">Ana sayfa</a><a href="iletisim.html">İletişim</a></nav></header>
  <main><section class="hero"><h1>İletişim</h1><p>E-posta: info@example.com</p></section></main>
</body>
</html>
`,
      'styles.css': `*{box-sizing:border-box}body{margin:0;font-family:system-ui,sans-serif;color:#1d2733;background:#f7f8fa}
.top{display:flex;justify-content:space-between;align-items:center;padding:14px 20px;background:#fff;border-bottom:1px solid #e3e7ec}
.top nav a{margin-left:16px;color:#234e8c;text-decoration:none}
.hero{max-width:860px;margin:0 auto;padding:64px 20px}.hero h1{font-size:clamp(28px,6vw,48px);margin:0 0 12px}
.cta{display:inline-block;margin-top:16px;padding:12px 20px;border-radius:8px;background:#234e8c;color:#fff;text-decoration:none}
`,
      'app.js': `document.documentElement.dataset.ready = 'true';\n`,
      '.gitignore': gitignore(),
      'README.md': readme(name, ['Statik site. `index.html` dosyasını düzenleyin; build gerekmez.']),
      'projecthub.yml': `project:
  name: ${name}
  slug: ${slug}
  version: 0.1.0
runtime:
  type: static
build:
  output: .
preview:
  enabled: true
  ttl: 7d
  mode: static
deploy:
  source: .
  exclude: [README.md]
smoke:
  paths: [/, /iletisim.html]
`,
    }),
  },

  'node-api': {
    id: 'node-api',
    name: 'Node.js API',
    description: 'Bağımlılıksız Node.js HTTP API: sağlık kontrolü, JSON uç noktaları ve node:test testleri.',
    technologies: ['Node.js'],
    requires: 'Node.js 22+',
    files: ({ name, slug }) => ({
      'package.json': `${JSON.stringify({ name: slug, version: '0.1.0', private: true, type: 'module', engines: { node: '>=22' }, scripts: { build: 'node --check server.mjs && node --check src/app.mjs', start: 'node server.mjs', test: 'node --test' } }, null, 2)}\n`,
      'package-lock.json': `${JSON.stringify({ name: slug, version: '0.1.0', lockfileVersion: 3, requires: true, packages: { '': { name: slug, version: '0.1.0', engines: { node: '>=22' } } } }, null, 2)}\n`,
      'src/app.mjs': `/** Request handler, kept separate from the server so tests can call it directly. */
const items = [{ id: 1, name: 'Örnek kayıt' }];

export function handle(method, url) {
  const path = url.split('?')[0];
  if (method === 'GET' && path === '/api/health') return { status: 200, body: { status: 'ok' } };
  if (method === 'GET' && path === '/api/items') return { status: 200, body: { data: items } };
  if (method === 'GET' && path === '/') return { status: 200, body: { name: ${JSON.stringify(name)}, endpoints: ['/api/health', '/api/items'] } };
  return { status: 404, body: { error: 'Bulunamadı' } };
}
`,
      'server.mjs': `import http from 'node:http';
import { handle } from './src/app.mjs';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';
http
  .createServer((req, res) => {
    const r = handle(req.method ?? 'GET', req.url ?? '/');
    res.writeHead(r.status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(r.body));
  })
  .listen(port, host, () => console.log(\`listening on \${host}:\${port}\`));
`,
      'test/app.test.mjs': `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handle } from '../src/app.mjs';

test('health endpoint', () => {
  assert.deepEqual(handle('GET', '/api/health'), { status: 200, body: { status: 'ok' } });
});

test('unknown path is 404', () => {
  assert.equal(handle('GET', '/nope').status, 404);
});
`,
      '.env.example': 'DATABASE_URL=\n',
      '.gitignore': gitignore(),
      'README.md': readme(name, ['Node.js API. `npm start` ile çalışır, `npm test` ile test edilir.']),
      'projecthub.yml': `project:
  name: ${name}
  slug: ${slug}
  version: 0.1.0
runtime:
  type: node
  version: "22"
install:
  command: npm ci
build:
  command: npm run build
test:
  command: npm test
start:
  command: npm start
  port: 3000
health:
  path: /api/health
preview:
  enabled: true
  ttl: 24h
  mode: process
smoke:
  paths: [/api/health]
`,
    }),
  },

  'react-spa': {
    id: 'react-spa',
    name: 'React SPA (Vite)',
    description: 'React 19 + Vite tek sayfa uygulama; statik çıktı, istemci tarafı yönlendirme.',
    technologies: ['React', 'Vite', 'JavaScript'],
    requires: 'Node.js 22+ (npm registry erişimi)',
    files: ({ name, slug }) => ({
      'package.json': `${JSON.stringify(
        {
          name: slug,
          version: '0.1.0',
          private: true,
          type: 'module',
          scripts: { dev: 'vite', build: 'vite build', test: 'node --test', preview: 'vite preview' },
          dependencies: { react: '^19.2.0', 'react-dom': '^19.2.0' },
          devDependencies: { vite: '^7.0.0', '@vitejs/plugin-react': '^5.0.0' },
        },
        null,
        2,
      )}\n`,
      'index.html': `<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(name)}</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.jsx"></script>
</body>
</html>
`,
      'vite.config.js': `import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({ plugins: [react()] });
`,
      'src/main.jsx': `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`,
      'src/App.jsx': `import { useState } from 'react';
import { greeting } from './greeting.js';

export function App() {
  const [count, setCount] = useState(0);
  return (
    <main className="app">
      <h1>{greeting(${JSON.stringify(name)})}</h1>
      <button onClick={() => setCount((c) => c + 1)}>Tıklama: {count}</button>
    </main>
  );
}
`,
      'src/greeting.js': `export const greeting = (name) => \`\${name} uygulamasına hoş geldiniz\`;\n`,
      'src/styles.css': `body{margin:0;font-family:system-ui,sans-serif;background:#f7f8fa;color:#1d2733}
.app{max-width:720px;margin:0 auto;padding:48px 20px}
button{padding:10px 16px;border-radius:8px;border:0;background:#234e8c;color:#fff;font-size:15px}
`,
      'test/greeting.test.js': `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { greeting } from '../src/greeting.js';

test('greeting includes the name', () => {
  assert.match(greeting('Deneme'), /Deneme/);
});
`,
      '.gitignore': gitignore(),
      'README.md': readme(name, ['React + Vite. `npm install && npm run dev` ile yerelde çalışır.']),
      'projecthub.yml': `project:
  name: ${name}
  slug: ${slug}
  version: 0.1.0
runtime:
  type: node
  version: "22"
install:
  command: npm install --no-audit --no-fund
build:
  command: npm run build
  output: dist
test:
  command: npm test
preview:
  enabled: true
  ttl: 24h
  mode: static
  spa: true
deploy:
  source: dist
smoke:
  paths: [/]
`,
    }),
  },

  'nextjs-postgres': {
    id: 'nextjs-postgres',
    name: 'Next.js + PostgreSQL',
    description: 'Next.js (App Router) sunucu uygulaması, pg ile PostgreSQL, SQL migration ve sağlık uç noktası.',
    technologies: ['Next.js', 'React', 'PostgreSQL'],
    requires: 'Node.js 22+ (npm registry erişimi), çalışma zamanında PostgreSQL',
    files: ({ name, slug }) => ({
      'package.json': `${JSON.stringify(
        {
          name: slug,
          version: '0.1.0',
          private: true,
          type: 'module',
          scripts: { dev: 'next dev', build: 'next build', start: 'next start', test: 'node --test', migrate: 'node scripts/migrate.mjs' },
          dependencies: { next: '^16.4.0', react: '^19.2.0', 'react-dom': '^19.2.0', pg: '^8.16.0' },
        },
        null,
        2,
      )}\n`,
      'next.config.mjs': `/** @type {import('next').NextConfig} */
export default { poweredByHeader: false };
`,
      'app/layout.jsx': `export const metadata = { title: ${JSON.stringify(name)} };

export default function RootLayout({ children }) {
  return (
    <html lang="tr">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0, background: '#f7f8fa', color: '#1d2733' }}>{children}</body>
    </html>
  );
}
`,
      'app/page.jsx': `import { listNotes } from '../lib/notes.js';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const result = await listNotes();
  return (
    <main style={{ maxWidth: 760, margin: '0 auto', padding: '48px 20px' }}>
      <h1>${esc(name)}</h1>
      {result.ok ? (
        <ul>{result.notes.map((n) => <li key={n.id}>{n.body}</li>)}</ul>
      ) : (
        <p>Veritabanı bağlı değil: {result.reason}. DATABASE_URL secret'ını ekleyin ve <code>npm run migrate</code> çalıştırın.</p>
      )}
    </main>
  );
}
`,
      'app/api/health/route.js': `export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({ status: 'ok' });
}
`,
      'lib/notes.js': `import pg from 'pg';

let pool;
function db() {
  if (!process.env.DATABASE_URL) return null;
  pool ??= new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
  return pool;
}

/** Reads notes; reports (instead of crashing) when the database is not configured or not migrated. */
export async function listNotes() {
  const p = db();
  if (!p) return { ok: false, reason: 'DATABASE_URL tanımlı değil' };
  try {
    const r = await p.query('SELECT id, body FROM notes ORDER BY id DESC LIMIT 20');
    return { ok: true, notes: r.rows };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}
`,
      'db/migrations/0001_notes.sql': `CREATE TABLE IF NOT EXISTS notes (
  id serial PRIMARY KEY,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO notes (body) VALUES ('İlk not');
`,
      'scripts/migrate.mjs': `import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

/** Applies db/migrations/*.sql in order, once each (tracked in schema_migrations). */
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
const dir = path.resolve('db/migrations');
for (const file of (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
  const done = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
  if (done.rowCount) continue;
  await client.query('BEGIN');
  await client.query(await fs.readFile(path.join(dir, file), 'utf8'));
  await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
  await client.query('COMMIT');
  console.log('applied', file);
}
await client.end();
`,
      'test/health.test.mjs': `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GET } from '../app/api/health/route.js';

test('health route answers ok', async () => {
  assert.deepEqual(await GET().json(), { status: 'ok' });
});
`,
      '.env.example': 'DATABASE_URL=postgres://user:password@localhost:5432/app\n',
      '.gitignore': gitignore(),
      'README.md': readme(name, ['Next.js + PostgreSQL. Yerelde: `npm install`, `DATABASE_URL=... npm run migrate`, `npm run dev`.']),
      'projecthub.yml': `project:
  name: ${name}
  slug: ${slug}
  version: 0.1.0
runtime:
  type: node
  version: "22"
install:
  command: npm install --no-audit --no-fund
build:
  command: npm run build
  timeoutMinutes: 20
test:
  command: npm test
start:
  command: npx next start -p $PORT -H 127.0.0.1
  port: 3000
health:
  path: /api/health
database:
  type: postgresql
  migrate:
    command: npm run migrate
    directory: db/migrations
preview:
  enabled: true
  ttl: 24h
  mode: process
smoke:
  paths: [/api/health]
env:
  - name: DATABASE_URL
    required: false
    description: PostgreSQL bağlantı adresi
`,
    }),
  },

  laravel: {
    id: 'laravel',
    name: 'Laravel',
    description: 'Laravel (PHP) uygulama iskeleti: yönlendirme, Blade görünümü, sağlık uç noktası (/up), migration klasörü.',
    technologies: ['PHP', 'Laravel'],
    requires: 'PHP 8.2+ ve Composer (packagist erişimi)',
    files: ({ name, slug }) => ({
      'composer.json': `${JSON.stringify(
        {
          name: `company/${slug}`,
          type: 'project',
          require: { php: '^8.2', 'laravel/framework': '^12.0' },
          autoload: { 'psr-4': { 'App\\': 'app/' } },
          config: { 'optimize-autoloader': true, 'sort-packages': true },
          'minimum-stability': 'stable',
          'prefer-stable': true,
        },
        null,
        2,
      )}\n`,
      artisan: `#!/usr/bin/env php
<?php

use Illuminate\\Foundation\\Application;
use Symfony\\Component\\Console\\Input\\ArgvInput;

define('LARAVEL_START', microtime(true));

require __DIR__.'/vendor/autoload.php';

/** @var Application $app */
$app = require_once __DIR__.'/bootstrap/app.php';

exit($app->handleCommand(new ArgvInput));
`,
      'bootstrap/app.php': `<?php

use Illuminate\\Foundation\\Application;
use Illuminate\\Foundation\\Configuration\\Exceptions;
use Illuminate\\Foundation\\Configuration\\Middleware;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware): void {})
    ->withExceptions(function (Exceptions $exceptions): void {})
    ->create();
`,
      'app/Http/Controllers/Controller.php': `<?php\n\nnamespace App\\Http\\Controllers;\n\nabstract class Controller\n{\n}\n`,
      'bootstrap/providers.php': `<?php\n\nreturn [];\n`,
      'bootstrap/cache/.gitignore': '*\n!.gitignore\n',
      'public/index.php': `<?php

use Illuminate\\Foundation\\Application;
use Illuminate\\Http\\Request;

define('LARAVEL_START', microtime(true));

require __DIR__.'/../vendor/autoload.php';

/** @var Application $app */
$app = require_once __DIR__.'/../bootstrap/app.php';

$app->handleRequest(Request::capture());
`,
      'routes/web.php': `<?php

use Illuminate\\Support\\Facades\\Route;

Route::get('/', fn () => view('welcome', ['name' => config('app.name')]));
`,
      'routes/console.php': `<?php\n`,
      'resources/views/welcome.blade.php': `<!doctype html>
<html lang="tr">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>{{ $name }}</title></head>
<body style="font-family:system-ui,sans-serif;max-width:760px;margin:0 auto;padding:48px 20px">
  <h1>{{ $name }}</h1>
  <p>Laravel {{ app()->version() }} çalışıyor.</p>
</body>
</html>
`,
      'database/migrations/2026_01_01_000000_create_contacts_table.php': `<?php

use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('contacts', function (Blueprint $table) {
            $table->id();
            $table->string('name');
            $table->string('email');
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('contacts');
    }
};
`,
      'storage/app/.gitignore': '*\n!.gitignore\n',
      'storage/framework/cache/.gitignore': '*\n!.gitignore\n',
      'storage/framework/sessions/.gitignore': '*\n!.gitignore\n',
      'storage/framework/views/.gitignore': '*\n!.gitignore\n',
      'storage/logs/.gitignore': '*\n!.gitignore\n',
      '.env.example': `APP_NAME="${name.replace(/"/g, '')}"
APP_ENV=production
APP_KEY=
APP_DEBUG=false
APP_URL=http://localhost
LOG_CHANNEL=stderr
SESSION_DRIVER=file
CACHE_STORE=file
QUEUE_CONNECTION=sync
DB_CONNECTION=pgsql
DB_URL=
`,
      '.gitignore': gitignore(['/vendor/']),
      'README.md': readme(name, ['Laravel. Yerelde: `composer install`, `cp .env.example .env`, `php artisan key:generate`, `php artisan serve`.']),
      'projecthub.yml': `project:
  name: ${name}
  slug: ${slug}
  version: 0.1.0
runtime:
  type: php
  version: "8.3"
install:
  command: composer install --no-dev --no-interaction --prefer-dist --optimize-autoloader
build:
  command: php -r "file_exists('.env') || copy('.env.example', '.env');" && php artisan key:generate --force && php artisan view:cache
test:
  command: php artisan route:list
start:
  command: php artisan serve --host=127.0.0.1 --port=$PORT
  port: 8000
health:
  path: /up
database:
  type: postgresql
  migrate:
    command: php artisan migrate --force
    directory: database/migrations
preview:
  enabled: true
  ttl: 24h
  mode: process
deploy:
  exclude: [tests]
smoke:
  paths: [/, /up]
env:
  - name: DB_URL
    required: false
    description: Veritabanı bağlantı adresi (postgresql://…)
`,
    }),
  },

  fastapi: {
    id: 'fastapi',
    name: 'Python FastAPI',
    description: 'FastAPI + Uvicorn API servisi, pytest testleri, otomatik API dokümantasyonu (/docs).',
    technologies: ['Python', 'FastAPI'],
    requires: 'Python 3.11+ (PyPI erişimi)',
    files: ({ name, slug }) => ({
      'requirements.txt': 'fastapi>=0.115\nuvicorn>=0.32\nhttpx>=0.28\npytest>=8\n',
      'main.py': `from fastapi import FastAPI

app = FastAPI(title=${JSON.stringify(name)})

ITEMS = [{"id": 1, "name": "Örnek kayıt"}]


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/api/items")
def items() -> dict:
    return {"data": ITEMS}


@app.get("/")
def root() -> dict:
    return {"name": app.title, "docs": "/docs"}
`,
      'tests/test_main.py': `from fastapi.testclient import TestClient

from main import app

client = TestClient(app)


def test_health() -> None:
    assert client.get("/api/health").json() == {"status": "ok"}


def test_items() -> None:
    assert client.get("/api/items").json()["data"][0]["id"] == 1
`,
      'tests/__init__.py': '',
      'pytest.ini': '[pytest]\npythonpath = .\ntestpaths = tests\n',
      '.gitignore': gitignore(['__pycache__/', '.pydeps/', '.venv/']),
      'README.md': readme(name, ['FastAPI. Yerelde: `pip install -r requirements.txt`, `uvicorn main:app --reload`. Dokümantasyon: `/docs`.']),
      'projecthub.yml': `project:
  name: ${name}
  slug: ${slug}
  version: 0.1.0
runtime:
  type: python
  version: "3.13"
install:
  command: python -m pip install --target .pydeps -r requirements.txt
build:
  command: python -m compileall -q main.py
test:
  command: python -m pytest -q
start:
  command: python -m uvicorn main:app --host 127.0.0.1 --port $PORT
  port: 8000
health:
  path: /api/health
preview:
  enabled: true
  ttl: 24h
  mode: process
smoke:
  paths: [/api/health]
`,
    }),
  },

  custom: {
    id: 'custom',
    name: 'Özel',
    description: 'Yalnızca README ve açıklamalı bir projecthub.yml; kodu sonra ekleyin.',
    technologies: [],
    requires: '—',
    files: ({ name, slug }) => ({
      'README.md': readme(name, ['Kodunuzu Git ile gönderin veya kod editöründen ekleyin.']),
      '.gitignore': gitignore(),
      'projecthub.yml': `# Project Hub manifesti: kurulum, build, test, ön izleme ve deployment ayarları.
# Ayrıntılar: docs/manifest.md
project:
  name: ${name}
  slug: ${slug}
  version: 0.1.0
runtime:
  type: other
preview:
  enabled: false
`,
    }),
  },
};
