# Production readiness report — 2026-10-09

This report records what was implemented and actually verified on the development workstation. Protocol fakes,
genuine local-model inference, Compose validation and Docker engine startup are reported separately.

## Update — 2026-10-12 (Claude, after taking over the Local AI brief)

The sections below this one are the 2026-10-09 state. This update supersedes them where they differ.

### Verified on real infrastructure

| Check | Result |
| --- | --- |
| Full Vitest suite (`projecthub_claude_test`) | 27 files passed, 1 skipped · 105 tests passed, 4 skipped (opt-in real-model tests) |
| TypeScript (server workspace + web) | clean |
| Genuine local-model E2E (`PROJECTHUB_REAL_OLLAMA=1`, `qwen3:8b`, RTX 4070) | 3/3 passed |
| Browser E2E `apps/web/e2e/critical-flow.spec.ts` | passed (import → build → preview → feedback → version → deploy → archive) |
| Full-area run in an isolated organization (real API, worker, PostgreSQL, Ollama on GPU, Chromium) | **27/27** |
| Docker staging (`deploy/compose.staging.yaml`): images built, stack started, HTTPS through Traefik | **8/8** |
| Backup/restore drill (pg_dump → restore into a scratch DB; storage tar → `git fsck`) | 72/72 tables, audit chain identical, repos clean |

The full-area run covers: inviting and activating a new developer, admin-only APIs refused (403), a project hidden
from non-members (404), membership grant, encrypted `DATABASE_URL` secret (never listed in clear), build + preview of
the Next.js + PostgreSQL template, preview reading real rows after the deployment ran the project migration,
security scan, user review link + anonymous feedback, AI Q&A over SSE with citations, feedback triage, architecture
analysis, an editing task that writes a file, passes a verification build and stops at human approval (then rejected),
the AI control center showing the pending approval and GPU, team board/history/comments, discussion @mention
notification, signed webhook integration test, guide and presentation PDFs, staging deployment, production
deployment held for approval with self-approval refused (four-eyes), and 42 pages walked in the browser as developer
and admin without console errors.

On CPU only (GPU unavailable during one run): `qwen3:8b` ran at ~9 tokens/s; an architecture analysis took 181 s and
an editing task reached approval in 343 s. Usable for single, queued tasks — not for interactive use.

### Production defects found by real validation and fixed

1. **Traefik v3.5 could not talk to Docker Engine 29** ("API returned a 400", no routes, every URL 404) → `traefik:v3.6`.
2. **Traefik picked the internal network's address** for api/web (both are on `frontend` and `backend`) → requests
   timed out. Pinned with `--providers.docker.network=projecthub_frontend` and a fixed network name.
3. **Image build failed on slow networks**: every stage re-downloaded pnpm's native binary and timed out → fetched once
   in the base layer with retries.
4. **Ollama prompt truncation**: the provider never sent `num_ctx`; after Ollama 0.40.1 → 0.40.3 the default window
   shrank, the system prompt and tool definitions were cut (`truncated = 1`) and the coding agent stopped calling
   tools. Now `OLLAMA_CONTEXT_TOKENS` (default 16384) is sent on every call.
5. **Headless Chromium hung when the GPU driver failed** (screenshots, device tests, guide PDFs) → software rendering
   (`--disable-gpu --use-angle=swiftshader`).
6. AI correctness: sourced tasks ignored the requested type (a feedback triage ran the editing agent); a feedback triage
   was stored as project memory and pulled later tasks off-topic; object-shaped findings from small models were
   discarded; "no file changed" showed the model's own claim as the error. All fixed with tests where testable.
7. `/admin/system` walked the whole storage tree on every 15-s poll (13–15 s per call → proxy 500s) → shared, 5-minute
   cache.
8. Ollama listing the same tag twice broke the control-center UI (duplicate React keys) → de-duplicated.

### Added

- Infrastructure-as-code scanner (`packages/core/src/scan/infra.ts`): Docker Compose (privileged, docker.sock, host
  network/PID, dangerous capabilities, unconfined profiles, exposed datastores, inline secrets), Kubernetes (privileged,
  privilege escalation, root, host namespaces/hostPath, unpinned images, missing limits) and Terraform (open ingress,
  public buckets/databases, unencrypted storage, inline secrets), with remediation steps in the UI.
- AI control center operations panel (`GET /admin/ai/operations`): CPU/RAM/GPU, AI queue, pending approvals, running
  tasks with cancel, per-project index/embedding/memory status with re-index, one-click "stop autonomous changes".
- `deploy/compose.staging.yaml` (local staging) and the staging + drill procedures in `deploy/README.md`.

### Still open (needs the owner or real infrastructure)

- Production deployment and a real staging server with DNS/TLS (Let's Encrypt) — never done without approval.
- `qwen2.5-coder:7b` download was paused (slow network); `qwen3:8b` is the verified default. Resume with
  `ollama pull qwen2.5-coder:7b` and select it in the control center.
- Hostile repositories still need a dedicated rootless runner or microVM (unchanged from the section below).
- The bundled Ollama container was not started in staging (the host's Ollama was used to avoid a multi-GB download).

## A. Implemented Local AI system

- Native Ollama provider with streaming chat, deterministic generation settings, bounded timeouts, cancellation,
  token accounting, multi-turn tools and runtime/model/VRAM inventory.
- PostgreSQL project memory with category, verification state, provenance, inspection, correction, deletion,
  project isolation and hybrid lexical/semantic retrieval alongside indexed code and operational history.
- Incremental code indexing plus deterministic architecture snapshots: entrypoints, modules, dependency edges,
  cycles, coupling, duplicate groups, configuration, migrations and test frameworks.
- Bounded autonomous coding on AI-only branches, server-side tool schemas, task cancellation, verification builds
  and human approval before merge. Model input is explicitly untrusted and cannot expand permissions.
- Dedicated analysis workflows for debugging/build failures, security explanations, documentation, test generation,
  architecture review, impact analysis, database review, deployment review and project planning.
- Security scanning, dependency inventory and authorized cross-project portfolio analysis with technology,
  dependency and version-drift aggregation.
- Feedback triage and conversion to tracked tasks/fix agents, with persistent results and provenance.
- Controlled self-healing limited to allow-listed HTTP health rechecks, with opt-in, emergency stop, hourly rate
  limit, audit history and no shell/deployment/migration/secret/permission mutation.
- Explicit execution trust: new Git/ZIP imports are untrusted by default. API and worker independently block host
  build/test commands until an authorized operator marks the reviewed source trusted.
- Optional constrained Docker executor for trusted standalone-worker builds: ephemeral non-root containers,
  read-only root, dropped capabilities, no-new-privileges, CPU/RAM/PID/time limits, build/test network disabled,
  no socket mount, secret allowlisting and heartbeat-based orphan reconciliation.

Database migrations `0003` through `0006` add project memory, remediation history, expanded AI task types and
persisted code-chunk embeddings/model provenance. They were applied successfully to the local development database.

## B. Capability matrix

| # | Capability | Current status | Verified implementation / remaining limit |
| --- | --- | --- | --- |
| 1 | Project understanding | Functional | Incremental files/symbols/chunks plus persisted deterministic architecture graph and project detection. |
| 2 | Project memory | Functional (hybrid retrieval) | Durable scoped memories, provenance and UI controls plus local Ollama embeddings for code. Semantic and lexical candidates are merged with a lexical fallback. |
| 3 | Code generation/editing | Functional, approval-gated | Bounded multi-file agent, AI branch, diff/actions, verification build and human decision. Quality depends on model. |
| 4 | Debugging/error resolution | Functional | Build, feedback and finding context can produce analysis or a fix task; failed builds auto-queue analysis. |
| 5 | Autonomous task execution | Functional, bounded | Durable queue, cancellation, tool policy, step/token limits and approval. No mid-turn model checkpoint resume. |
| 6 | Architecture analysis | Functional | Deterministic cycles/coupling/duplicates plus a grounded `architecture_review` workflow. |
| 7 | Change impact/risk | Functional | Diff/migration checks, dependency graph and dedicated `impact_analysis`; human validation remains required. |
| 8 | Security analysis | Functional with limits | Local secret/code/config scan, optional OSV, dependency inventory and `security_explain`. No full container/IaC scanner suite. |
| 9 | Database intelligence | Functional with limits | Migration registry/risk, backup gates and `database_review`; it is not a live query optimizer. |
| 10 | Automated test generation | Functional, approval-gated | Dedicated `test_generation` editing workflow and real project test commands. Coverage targeting is project-specific. |
| 11 | Visual UI testing | Functional (deterministic) | Playwright viewports, screenshots and diffs. No local vision-model interpretation. |
| 12 | Deployment preparation | Functional, gated | Builds, versions, migration/security gates, approvals, backups, smoke/rollback and `deployment_review`. |
| 13 | Feedback intelligence | Functional | Triage, code search, metadata, tasks and fix-agent conversion persist in the project history. |
| 14 | Multi-project intelligence | Functional, permission-scoped | Portfolio endpoint aggregates only projects visible to the caller and reports shared dependencies/version drift. |
| 15 | Continuous monitoring | Functional with limits | Health/incidents/heartbeats plus optional diagnosis and controlled recheck. External certificate coverage is environment-specific. |
| 16 | Documentation generation | Functional, approval-gated | Dedicated `docs` workflow plus grounded Q&A and repository edit review. |
| 17 | AI project management | Functional | `project_plan` workflow integrates with task, feedback, build and timeline context. It recommends; humans prioritize. |
| 18 | Controlled self-healing | Functional, deliberately narrow | Only non-mutating health recheck is allow-listed. Emergency stop and rate limit default to safe settings. |

## C. Genuine local inference and hardware evidence

Host detected:

- HP ZBook Studio 16 G10
- Intel Core i7-13800H, 14 cores / 20 logical processors
- 31.6 GB RAM
- NVIDIA GeForce RTX 4070 Laptop GPU, 8,188 MiB VRAM; driver 573.44

Ollama 0.40.1 was installed per user and its local API was reachable on `127.0.0.1:11434`. A preserved local
`qwen3:8b` Q4_K_M model was used for genuine inference while the separately requested
`qwen2.5-coder:7b` download was in progress.

The portable `embeddinggemma:300m-qat-q4_0` embedding model was installed after the newer MLX-only tag proved
incompatible with the Windows runtime. A real batch returned three finite 768-dimensional vectors in 2.42 seconds;
the related-session similarity was 0.5758 versus 0.2022 for an unrelated invoice, and Ollama reported the 298 MB
model resident in VRAM. The worker then persisted real 768-dimensional vectors and model provenance during the
genuine API E2E setup.

Genuine checks (not protocol fakes):

- Real authentication → project provisioning/indexing → verified memory retrieval → SSE API → Ollama → persisted
  response completed. The first run exposed a missing memory-citation contract; the prompt/context/provenance logic
  was corrected and the rerun passed.
- A real model-selected tool loop called `read_marker`, consumed the hidden tool result, then called `finish`; the
  bounded tool test passed with non-zero input/output token counts.
- A real autonomous documentation task used the local model to inspect and edit its isolated project, persisted a
  reviewable diff, completed the configured verification build and stopped at the human approval boundary. The
  test rejected the proposal through the API; it did not merge or deploy it.
- Ollama `/api/ps` reported `qwen3:8b` fully in VRAM (`size_vram` 5,578,204,118 bytes).
- During a fresh 1,000-token generation, `nvidia-smi` repeatedly measured 89–98% GPU utilization and 5,493 MiB
  GPU memory use. Ollama reported 34 prompt tokens, 1,000 evaluated tokens and 25.46 seconds of evaluation time.
  This is actual GPU inference evidence.

The ordinary Ollama tests still use a fake HTTP server and are labeled protocol tests only.

## D. Verification evidence

Verified on 2026-10-09:

```text
TypeScript server workspace: passed
Next.js/web TypeScript:       passed
Vitest isolated regression:   23 files passed, 1 skipped; 91 tests passed, 3 real-AI tests intentionally skipped
Genuine Ollama E2E cases:     all 3 passed with qwen3:8b (run separately from protocol tests)
  - embedding/memory/SSE:     passed in 15.49s after exact-literal grounding hardening
  - model-selected tool loop: passed in 26.99s
  - autonomous edit/verify:   passed in 35.32s; stopped for human approval
Next.js production build:     passed, 18 static pages generated
Database migrations:         current; 0003–0006 applied
Docker Compose config:        passed via Docker Compose v5.5.1; 6 services / 3 networks
Docker engine/container:      passed; Desktop 4.94.0 / Engine 29.8.2 / real hello-world container
Constrained build container:  passed; non-root/no socket/no hub secrets/no network/automatic cleanup
GPU load sample:              89–98%, 5,493 MiB used, 1,000 tokens generated in 25.46s
```

The regression suite was run serially against the dedicated `projecthub_local_ai_test` database so concurrent
development and validation processes could not drop one another's schemas. The genuine-inference file is opt-in
and was run separately against that same isolated database with `PROJECTHUB_REAL_OLLAMA=1`; therefore its three
passes are not included in the 91-test functional/protocol count.

## E. Docker state

The valid Docker Inc-signed 4.94.0 installer was verified and installed successfully in per-user WSL 2 mode with
Windows containers disabled. The earlier 4.85 update rollback was traced to existing CLI-plugin hardlinks. Those
Docker-only links and malformed runtime socket directories were preserved under timestamped `.stale-*` names,
not deleted; no images, volumes, WSL distributions or VHDX data were reset.

The repaired Desktop engine is running and verified: Docker client/server 29.8.2, Compose 5.5.1, WSL 2.7.13,
20 CPUs, 16.58 GB assigned memory and `overlayfs`. A real `hello-world` image was pulled from Docker Hub and its
container completed successfully. Project Hub Compose validation succeeds using the checked-in production example:
6 services (`postgres`, `api`, `ollama`, `traefik`, `web`, `worker`), 3 networks and 4 named volumes. Ollama has no
host-published port and the worker has no Docker socket mount. The application stack was not started because no
real `deploy/.env` exists and a production deployment was explicitly out of scope.

## F. Security assessment

Implemented safeguards include organization/project access checks, encrypted secrets, append-only audit records,
prompt-injection boundaries, tool schemas, token/step/time limits, cancellation, branch isolation, verification
builds, human merge/deployment approvals, scoped memory provenance, self-healing emergency stop/rate limit and the
new untrusted-source execution gate.

Remaining production risks:

1. Host-mode trusted repositories execute build/test commands under the worker identity. The opt-in constrained
   container executor improves isolation, but hostile code still requires a dedicated rootless runner host or
   microVM; imported untrusted projects remain blocked.
2. Semantic ranking currently performs exact cosine comparison over PostgreSQL `real[]`; it does not yet use an
   approximate vector index and will need a vector extension or external store for very large repositories.
3. Container/IaC/image scanning and local vision-model UI interpretation are not implemented.
4. Docker multi-container startup, staging TLS/DNS, backup/restore drill and production credentials remain
   intentionally unverified.
5. Small local models can omit citations or alter identifiers. Deterministic scanners, tests and human approval
   remain the verification layer.

## G. Operator follow-up

1. Create a secret-bearing `deploy/.env` only on a non-production staging host, then run the Compose smoke test.
   Do not use `.env.production.example` as credentials and do not reset Docker data.
2. Let `ollama pull qwen2.5-coder:7b` finish, then rerun the gated genuine test with
   `PROJECTHUB_REAL_OLLAMA=1` and `OLLAMA_MODEL=qwen2.5-coder:7b`.
3. Perform a database plus storage backup/restore drill on a non-production copy.
4. Keep external Git/ZIP imports untrusted until their build scripts are reviewed.
5. Use a hardened remote/container runner before accepting hostile repositories.

No Git operation on the Project Hub workspace, no commit/push/reset and no production deployment was performed.
