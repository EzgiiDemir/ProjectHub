# 0006 — Single-server topology

**Status:** accepted

**Decision.** PostgreSQL 18, api (REST + Git HTTP + preview gateway), worker and web as four containers behind
Traefik on one host, sharing a `storage` volume (repositories, artifacts, logs, backups). The worker shares the
api container's network namespace so the gateway reaches app previews on 127.0.0.1 without exposing them.
Concurrency is capped per organization (builds, running app previews) and retention jobs clean artifacts, logs,
screenshots and health checks hourly.

**Consequences.** Simple operations and backups (one database dump + one volume). Scaling out means moving
`STORAGE_DIR` to shared storage and giving process previews a routable address — both are configuration-level
changes, not redesigns.
