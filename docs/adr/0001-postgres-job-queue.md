# 0001 — PostgreSQL as job queue and event bus (no Redis)

**Status:** accepted

**Context.** Builds, previews, deployments, scans, screenshots and AI tasks are long-running and must survive
restarts. The spec targets one 8 GB server to start.

**Decision.** A `jobs` table is the queue. Producers insert the job in the same transaction as the business row
(transactional outbox), so a job exists if and only if its row does. Workers claim with
`FOR UPDATE SKIP LOCKED`, hold a renewable lease, retry with 30 s / 2 min / 10 min backoff, and can defer without
consuming an attempt (capacity limits). A trigger `NOTIFY`s new jobs; realtime UI events use `pg_notify` → API →
SSE.

**Consequences.** One less service to run, back up and secure; jobs are queryable and visible in
*Altyapı ve sistem sağlığı*. Throughput is far below a dedicated broker but orders of magnitude above this
workload. Revisit if job volume reaches thousands per second.
