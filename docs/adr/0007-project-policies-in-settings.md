# 0007 — Project policies and derived data in `projects.settings`

**Status:** accepted

**Context.** Several per-project settings are small, read together with the project row and changed rarely:
branch protection, the deployment window, customer portal branding and the dependency inventory produced by the
security scan. Separate tables would each need a migration, a repository layer and joins on hot paths.

**Decision.** Store each one under its own key in the `projects.settings` JSONB column (`protection`,
`deploymentWindow`, `branding`, `dependencyInventory`). Each writer updates only its key with `jsonb_set`, so
concurrent writers (API settings screens, the worker's scan) never overwrite each other. Values are validated with
zod schemas from `@projecthub/contracts` on write and parsed again on read (`branchProtectionOf`,
`deploymentWindowOf`, `projectBrandingOf`); an invalid or missing value means "no policy".

**Consequences.** No schema migration for new project-level policies; the project row already carries them to the
services that enforce them (repository writes, deployment creation, the pre-receive hook environment, the customer
portal). Data that grows without bound or needs querying across projects (findings, deployments, backups,
migration runs) stays in proper tables. The dependency inventory keeps direct dependencies only (≤ 1000); the SBOM
is generated on demand from the lock files on the default branch, so it also lists transitive packages.
