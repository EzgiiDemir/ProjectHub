# Project Hub AI — local inference

Project Hub uses Ollama as its default AI runtime. Core AI features do not require an OpenAI or Anthropic key.
Anthropic and OpenAI adapters remain available only for installations that explicitly select and configure them.

## Data path and trust boundary

```text
browser -> Project Hub API -> PostgreSQL-backed retrieval -> worker/API -> Ollama /api/chat
                              |                           |
                              +-- project/org scope      +-- private network only
                              +-- source citations
                              +-- no project secrets
```

The model is never the authorization boundary. The API checks organization/project permissions, agent tools use
allow-listed schemas and server-side policies, edits are restricted to an `ai/...` branch, and a human approval is
required before merge. Tool calls and model usage are recorded in `ai_actions` and `ai_runs`. Repository content,
logs, feedback and model output are untrusted input and cannot grant the agent extra tools or permissions.

The retrieval layer combines PostgreSQL full-text search with optional Ollama embeddings over incrementally
maintained code chunks, plus durable project memories and deterministic architecture snapshots. Semantic and
lexical candidates are merged and remain project-scoped; if the embedding runtime is unavailable, retrieval
degrades to lexical search without losing the index. Memories carry category, verification state and provenance
and can be inspected, corrected or deleted in the AI project page. Embeddings and their model tag are persisted in
PostgreSQL by the worker. The current implementation uses exact cosine ranking over `real[]`, which is appropriate
for local repositories but should be replaced by a vector extension or external vector store at large scale.

## Local development

1. Install Ollama for the host operating system.
2. Pull a model that fits the machine:

   ```bash
   ollama pull qwen2.5-coder:7b
   ollama pull embeddinggemma:300m-qat-q4_0
   ```

3. Keep the defaults in `.env`, or set `OLLAMA_BASE_URL`, `OLLAMA_MODEL`, `OLLAMA_EMBEDDING_MODEL` and
   `OLLAMA_REQUEST_TIMEOUT_SECONDS`. Set `OLLAMA_EMBEDDING_MODEL` to an empty value to use lexical-only fallback.
4. Start Project Hub normally. *Yönetim → AI kontrol merkezi* shows runtime reachability, Ollama version, installed
   models, loaded models and reported VRAM use.

The URL is server-side configuration. Do not point it at an untrusted public endpoint: prompts contain permitted
project context. In local-only mode leave both cloud API keys empty and select `ollama`.

## Docker staging and production

The Compose stack includes Ollama on the internal application network and a persistent `ollama_data` volume. It
publishes no host port. A separate egress-only network lets the service download model weights, but no other
container reaches Ollama through that network. After the first start, install the configured model:

```bash
docker compose -f deploy/compose.yaml --env-file deploy/.env exec ollama ollama pull qwen2.5-coder:7b
docker compose -f deploy/compose.yaml --env-file deploy/.env exec ollama ollama pull embeddinggemma:300m-qat-q4_0
docker compose -f deploy/compose.yaml --env-file deploy/.env restart api worker
```

Model weights are an initial external download from the Ollama model registry. Mirror them or pre-populate the
volume for an air-gapped installation. Application prompts and inference remain local after installation.

GPU passthrough is host-specific and deliberately not assumed by the base Compose file. Configure the Docker
Engine NVIDIA runtime on a staging host before adding a GPU reservation override. CPU fallback works but agent
tasks may take minutes and should use low concurrency.

## Resource profiles

| Profile | Practical model | Settings | Expected limitation |
| --- | --- | --- | --- |
| CPU only, 16 GB RAM | 3B–7B Q4 | one AI job, short context | slow generation and weaker multi-file edits |
| 8 GB VRAM, 16–32 GB RAM | 7B Q4 coding model | one loaded model, one or two AI jobs | long repositories still rely on retrieval |
| 16–24 GB VRAM | 14B Q4/Q5 coding model | one or two AI jobs | validate actual context/VRAM before increasing concurrency |
| Dedicated 48 GB+ server | larger coding/reasoning models | benchmark then tune | higher power, warm-up and queue costs |

Model quality varies. A local model result is a proposal, not proof: builds, tests, scanners and human review remain
the verification layer. Never increase autonomous permissions merely because a larger model is installed.

## AI control center operations panel

*Yönetim → AI kontrol merkezi* (`GET /api/v1/admin/ai/operations`, `admin.settings.manage`) shows, refreshed every
10 seconds:

- host CPU (sampled), RAM and GPU utilization/VRAM (`nvidia-smi` on the API host; "CPU modu" when absent),
- the AI job queue (running / waiting / failed in 24 h),
- AI changes waiting for a human decision (link to the diff review) and running tasks (cancel button),
- per project: indexed files, code chunks, share with semantic embeddings, memories (verified count), last index,
  with a re-index button,
- "Otonom değişiklikleri durdur": drops the autonomy level to L1 so the AI can only read and explain.

## Choosing the model on a workstation

The organization setting (*Model* in the control center) overrides `OLLAMA_MODEL`. When the configured tag is not
installed the status is "Kapalı" with the exact `ollama pull` command; AI actions are refused up front instead of
creating failing tasks. On the validation laptop (RTX 4070 8 GB) `qwen3:8b` Q4_K_M is the verified default;
`qwen2.5-coder:7b` can replace it once downloaded (`ollama pull qwen2.5-coder:7b`, ~4.7 GB).

## Operations and troubleshooting

- `GET /api/v1/ai/status` reports the selected provider and local runtime inventory without exposing credentials.
- `ollama list` confirms installed models; `ollama ps` shows loaded models and memory allocation.
- “Yerel model yüklü değil” means the configured tag does not match an installed model; pull it or select one shown
  in the control center.
- “Ollama servisine ulaşılamıyor” means the server-side `OLLAMA_BASE_URL` is unreachable. Check the service health
  and private-network DNS; do not expose port 11434 publicly as a workaround.
- Requests are cancelled when the client closes the stream and are bounded by `OLLAMA_REQUEST_TIMEOUT_SECONDS`.
- Back up `ollama_data` only if avoiding model re-download matters. Project memory, verification/provenance,
  remediation history and AI audit records live in PostgreSQL and belong in the normal database backup.

## Verified scope

The Ollama adapter has protocol-level automated coverage for streamed chat, usage accounting, embeddings and
multi-turn tool execution. A separate opt-in test (`PROJECTHUB_REAL_OLLAMA=1`) performs genuine authentication,
worker indexing, persistence of a real 768-dimensional embedding, database-backed memory retrieval, SSE inference,
model-selected tools and an autonomous edit/build/review flow against the configured local model. On the validated
host, `qwen3:8b` ran fully on the RTX 4070 Laptop GPU; a fresh 1,000-token generation sustained 89–98% sampled
utilization, used 5,493 MiB VRAM and took 25.46 seconds of model evaluation. `embeddinggemma:300m-qat-q4_0` also
completed real 768-dimensional embedding inference locally. Protocol fakes remain useful unit tests but are never
reported as evidence of installed-model inference.
