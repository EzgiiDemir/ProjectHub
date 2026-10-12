# Project Hub

Project Hub is the company's single place for its software projects: source code (built-in Git server), builds,
time-limited previews, a device simulator, customer review links with on-page feedback, versions, deployments to
real servers (SFTP / SSH / FTP / local folder), database backups, security scanning, incidents and a project AI
assistant that only proposes changes for human approval. The UI is Turkish; code and docs are English. User-facing
text calls reviewers "kullanıcı" (never "müşteri"); see [`AGENTS.md`](AGENTS.md).

Team features on top of that:

- **Home dashboard** (`GET /home/insights`): 14-day build/deployment/commit/feedback charts, 30-day delivery stats,
  production environments, task counts, activity feed and security averages.
- **Team work** (`/team`, `/projects/<slug>/discussion`): todo → doing → review → done board with drag and drop,
  assignment (only to people who can see the project), due dates and labels, task history, comments, the task's
  commits (branch + `PH-n` mentions) and pull request, project discussion with replies, @mentions and pins.
- **Security finding resolution**: each finding shows problem → solution → actions (exact upgrade command, revoke
  links, OSV, file). "Çözüldü" re-scans the project and reports whether the finding is really gone.
- **Integrations** (`/projects/<slug>/integrations`): Microsoft Entra ID, WordPress / WPForms, Google Analytics,
  SMTP, Slack, signed webhooks and generic REST APIs. Values are stored as encrypted env secrets and every provider
  has a real connection test.
- **User guide and presentation** (`/projects/<slug>/guide`): the worker crawls a ready preview, takes screenshots and
  produces an A4 user guide PDF and a 16:9 presentation PDF in plain Turkish (AI-written when the local model is
  available, rule-based otherwise).
- **Navigation**: top bar with ARUCAD branding (`apps/web/components/brand`), project pages grouped into tabs, and a
  status bar footer.

The product requirements live in [`docs/spec`](docs/spec) (Turkish) and the original click-through prototype in
[`docs/prototype`](docs/prototype). Architecture decisions are recorded in [`docs/adr`](docs/adr).

## Architecture

```
 browser ──► web (Next.js 16, :3100) ──rewrites──► api (NestJS 12, :4000) ──► PostgreSQL 18
                    │                                   │  ▲                     ▲
                    │ /r/<token>  customer portal       │  │ LISTEN/NOTIFY       │ jobs table (SKIP LOCKED)
                    ▼                                   ▼  │                     │
 <slug>.preview.<domain> ──────────────► preview gateway (in api, :4100)    worker (builds, previews,
                                                                             deployments, scans, browser, AI)
```

| Part | Path | What it does |
| --- | --- | --- |
| `@projecthub/contracts` | `packages/contracts` | Shared zod schemas, permission catalog, status vocabularies, `projecthub.yml` schema |
| `@projecthub/database` | `packages/database` | Drizzle schema, SQL migrations (append-only audit trigger, job NOTIFY, FTS), reference seed |
| `@projecthub/core` | `packages/core` | Config, crypto, Git plumbing, durable job queue, scanners, manifest/detection, AI providers |
| `@projecthub/api` | `apps/api` | REST API (`/api/v1`), Git over HTTPS (`/git`), SSE streams, preview gateway |
| `@projecthub/worker` | `apps/worker` | Job handlers: repository import/sync, builds, previews, Playwright jobs, deployments, scans, AI |
| `@projecthub/web` | `apps/web` | Next.js UI, customer review portal (`/r/<token>`) |

Long-running work never happens in a request: the API writes a row and enqueues a job **in the same transaction**
(transactional outbox), the worker claims it with `FOR UPDATE SKIP LOCKED`, and progress reaches browsers through
PostgreSQL `NOTIFY` → API → Server-Sent Events.

## Requirements

- Node.js 24+, Git 2.38+ (`git merge-tree --write-tree`), corepack (`npm i -g corepack && corepack enable`)
- PostgreSQL 18 (or `pnpm db:start` for a local one), UTF-8 database
- Optional: Playwright Chromium for screenshots and device tests, `pg_dump` 18 for deployment backups,
  Ollama plus a locally installed model for AI features, SMTP for e-mail. Cloud AI keys are optional compatibility
  integrations and are not required.

## Local development

```bash
corepack pnpm install
cp .env.example .env                       # then set APP_ENCRYPTION_KEY (command is in the file)
pnpm db:start                              # embedded PostgreSQL 18 on 127.0.0.1:54329 (keep it running)
pnpm build:server && pnpm db:migrate
pnpm admin:create --email you@company.com --name "Ad Soyad" --org "Şirket Adı"
pnpm --filter @projecthub/worker exec playwright install chromium   # screenshots / device tests
ollama pull qwen2.5-coder:7b                 # local AI model (configurable)
pnpm dev                                   # api :4000, preview gateway :4100, worker, web :3100
```

Open http://localhost:3100. Previews are served on `http://<slug>.preview.localhost:4100` — browsers resolve
`*.localhost` to the local machine, so no DNS setup is needed.

To try the full flow, import [`test/fixtures/nova-shop`](test/fixtures/nova-shop) with *Proje ekle / içe aktar →
Klasör seç*: it is a small Node shop with a build, tests, a health endpoint and a migration.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Watch-compile server packages and run api, worker and web together |
| `pnpm build` | Compile everything (server packages with `tsc -b`, web with `next build`) |
| `pnpm db:start` / `pnpm db:migrate` | Local PostgreSQL / apply migrations (also applied automatically when the API starts) |
| `pnpm admin:create` | Create the first organization and Super Admin (password from `PH_ADMIN_PASSWORD` or prompt) |
| `pnpm typecheck` | Type-check all packages and the web app |
| `pnpm test` | Build, then run unit and integration tests (needs PostgreSQL; uses `TEST_DATABASE_URL`, a `*_test` database) |
| `pnpm test:e2e` | Browser end-to-end flow against a running instance (`E2E_EMAIL`, `E2E_PASSWORD`) |
| `pnpm start:api` / `start:worker` / `start:web` | Run the built services |

## Tests

`pnpm test` covers, against real infrastructure rather than mocks:

- **Git**: commits without a working copy, compare-and-swap edits, merges and conflicts, non-destructive upstream sync.
- **Queue**: transactional enqueue, retries, permanent failures, deferral.
- **Scanners and detection**: secrets, code risks, migration risk, lockfiles, CVSS, project type detection.
- **API** (`apps/api/test`): the real Nest server and the `admin:create` CLI on a fresh database — login, CSRF,
  role and project permissions, invitations, API tokens, append-only audit trail. Suites that need background work
  run the real worker handlers in-process: pull requests and branch protection (including a rejected `git push`),
  database safety (update analysis, migration tracking, verified `pg_dump` backups, exact restores with a safety
  backup and two-person production approval), the dependency center and CycloneDX SBOM (against a local OSV/npm
  fake), log search, the deployment window policy, notification preferences, customer portal branding and the
  role-based home sections, the team board (assignment rules, task history, comments, discussion), integrations
  (against a fake WordPress server), security finding resolution with re-scan verification, and the dependency
  upgrade refusing to create an AI task when no model is reachable.
- **Artifact links** (`packages/core/test/storage.test.ts`): copying and moving build outputs that contain links
  (Turbopack's `.next/node_modules/<pkg>-<hash>`; junctions on Windows) keeps previews of Next.js apps with server
  packages such as `pg` working after the build workspace is removed.
- **Deployment adapters** (`apps/worker/test/adapters.test.ts`): an in-process SSH/SFTP server and an FTP server —
  upload, atomic swap, rollback, pruning, remote command.
- **AI** (`apps/worker/test/ai-task.test.ts`, `packages/core/test/ai.test.ts`): the real fix-agent job and the
  official SDKs against protocol-level fakes of the Anthropic Messages (streaming) and OpenAI Responses APIs —
  tool calls, policy denials, token accounting, refusals, autonomy caps.

`pnpm test:e2e` drives the main promise through the UI: import a folder → build → preview → customer link →
customer feedback from an anonymous browser → version → deploy → archive.

## Configuration

All settings are environment variables validated at startup ([`.env.example`](.env.example) documents each one).
Organization-level settings (AI provider/model/autonomy/budget, retention and capacity, webhooks) are managed in
the UI under *Yönetim*. Project-level policies — branch protection (*Branch ve commit*), the deployment window
(*Ortamlar*) and customer portal branding (*Müşteri linkleri*) — are stored in the project's settings. The
dependency center compares versions with the registries in `NPM_REGISTRY_URL`, `PYPI_URL` and `PACKAGIST_URL`
(leave empty for offline installs) and vulnerabilities with `OSV_API_URL`. Per-project behaviour lives in the repository's [`projecthub.yml`](docs/manifest.md).
Local inference setup, isolation boundaries and hardware profiles are documented in
[`docs/local-ai.md`](docs/local-ai.md).

## Production

See [`deploy/README.md`](deploy/README.md): one `Dockerfile` with `api`, `worker` and `web` targets and a
`deploy/compose.yaml` with PostgreSQL 18 and Traefik (TLS, `/api` + `/git` routing, wildcard preview domain).

## Security model (summary)

- Passwords: argon2id; sessions and API tokens stored as SHA-256 hashes; account lockout after repeated failures.
- Secrets, deployment credentials and review tokens: AES-256-GCM with `APP_ENCRYPTION_KEY`; values never listed,
  reveals are audited.
- Cookie writes require the `x-requested-with: projecthub` header and a same-origin `Origin`.
- Role-based permissions per organization and per project; four-eyes approval for protected environments.
- Production deployments are blocked while critical security findings are open (audited override only).
- Optional deployment window: outside the allowed days/hours a deployment needs an approval or is refused
  (rollbacks are never refused). Protected branches only change through reviewed pull requests, also over `git push`.
- Database restores always take a safety backup first; production restores need a second database manager.
- AI works on its own `ai/…` branch, cannot read secrets or `projecthub.yml`, cannot merge or deploy; a human
  approves after a verification build.
- Builds and previews run with a scrubbed environment (the hub's own settings and keys are removed).
- The audit trail is append-only at the database level (UPDATE/DELETE are rejected by a trigger).
