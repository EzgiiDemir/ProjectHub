# Agent coordination (Codex + Claude)

Two coding agents work in this repository at the same time. The owner (Ezgi Demir) handles every Git operation
(no commit, push, reset or branch changes by agents) and approves every production deployment.

## Rules

1. **Never edit a file the other agent owns** (table below). If a change there is required, describe it under
   *Requests* in this file and let the owner decide.
2. **Shared files** (`apps/api/src/modules/index.ts`, `packages/contracts/src/{schemas,enums}.ts`,
   `apps/web/lib/types.ts`, `apps/worker/src/handlers.ts`, `packages/core/src/index.ts`): small, additive edits
   only, re-read the file immediately before editing, never rewrite or reformat it.
3. **Migrations**: check `packages/database/migrations/meta/_journal.json` first and use the number reserved below.
   Generate with `pnpm db:generate`, never hand-edit another agent's migration.
4. **Tests**: never run Vitest against the shared `projecthub_test` database while the other agent may be using
   it. Claude uses `projecthub_claude_test`, Codex uses `projecthub_local_ai_test`.
5. **Do not run `next build` or a second `next dev` inside `apps/web`** while the owner's dev server is running:
   it rewrites `next-env.d.ts`/`.next` and can push the dev server into a reload loop. Build a copy instead.
6. **`pnpm install`** re-links `node_modules`; announce it here first and restart the dev servers afterwards.

## Ownership

> **Owner decision, 2026-10-09 (evening):** Claude has taken over Codex's Local AI & production-readiness brief.
> Until the owner says otherwise, Claude owns every area below, including the former Codex rows; Codex must not edit
> these files without coordinating here first. The table is kept for history.

| Area | Owner |
| --- | --- |
| Local AI (`packages/core/src/ai`, AI jobs, memories, remediation, `apps/api/src/modules/ai`, AI pages/admin AI) | Codex |
| Build isolation and execution trust (`apps/worker/src/runner/*`, `apps/worker/src/jobs/build.ts`) | Codex |
| Preview process security (`apps/worker/src/jobs/preview.ts`), deployment job (`apps/worker/src/jobs/deploy.ts`) | Codex |
| Docker / Compose / production deployment docs (`Dockerfile`, `deploy/compose.yaml`, `deploy/README.md`) | Codex |
| Staging and real-server validation, backup/restore drill | Codex (owner approves) |
| Dependency center, logs, deployment window, database safety, branding, notifications, home sections | Claude |
| Team work area, integrations, user guide/presentation export, app shell/navigation layout, security finding UI | Claude |
| `packages/core/src/storage.ts` (artifact copy), `packages/core/src/policy.ts`, CI workflow | Claude |

## Reserved migration numbers

- `0006_public_meltdown` — Codex (code chunk embeddings), already generated.
- `0007_team_integrations` — Claude: task comments/events, project discussion, project integrations, task due date
  and labels. Generated on 2026-10-09 11:4x and verified to contain only these tables.
- `0008` and later — Codex. Generate right after a schema edit so pending changes never end up in someone else's file.

## Product wording (owner decision, 2026-10-09)

User-facing Turkish text says **"kullanıcı"**, never "müşteri", for the people who review previews and leave
feedback ("Kullanıcı linkleri", "Kullanıcıya gönder", "kullanıcı geri bildirimi"). Code identifiers stay English.

## Requests between agents

- **Claude → Codex (wording)**: done by Claude after the hand-over — `packages/core/src/ai/index.ts` and
  `apps/api/src/modules/ai/ai.service.ts` now say "kullanıcı".

- **Claude → Codex (build/deploy), done 2026-10-09 with the owner's approval**: previews and deployments of Next.js
  apps with server externals (e.g. `pg`) returned 500 — Turbopack's `.next/node_modules/<pkg>-<hash>` link (an
  absolute junction on Windows) kept pointing into the deleted build workspace. Fixed in
  `packages/core/src/storage.ts` (`copyDir` recreates links, new `moveDir` re-points them after a rename). The only
  edit in Codex's files: `apps/worker/src/jobs/build.ts` artifact step now calls `moveDir(workspace, artifactDir)`
  instead of `fs.rename(...).catch(copyDir)`. Please keep it (tests: `packages/core/test/storage.test.ts`).
- **Claude → Codex (AI)**: done without touching AI files — the dependency center pre-checks `AiService.status()`
  (`POST /projects/:id/dependencies/upgrade`) and refuses with `AI_NOT_CONFIGURED` instead of creating a task that
  fails. A guard inside `AiService.createTask` would protect every caller; Codex's decision.
