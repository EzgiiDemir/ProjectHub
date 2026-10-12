# 0003 — AI runs in the TypeScript worker behind a provider interface

**Status:** accepted

**Context.** The spec sketches a separate Python AI service. AI here needs the same data access, permissions,
audit trail, Git plumbing and job queue as everything else.

**Decision.** AI lives in `@projecthub/core/ai` and the worker: an `AiProvider` interface with Anthropic (default
`claude-opus-5-5`, streaming, server-side refusal fallback, eager tool-input streaming) and OpenAI (Responses API)
adapters; a tool-using agent loop that validates every tool input with zod, records every call (`ai_actions`) and
token usage (`ai_runs`), and enforces policies outside the model: own `ai/…` branch only, no secrets or
`projecthub.yml`, ≤ 30 files, no merge, no deploy, verification build before approval. Keys come only from the
server environment; `*_BASE_URL` allows a corporate gateway.

**Consequences.** One language and one deployment unit; the guarantees are code, not prompt text. Tests drive the
real SDKs against protocol-level fakes. Retrieval is PostgreSQL full-text over code chunks — no vector database;
revisit if answers need semantic search across very large codebases.
