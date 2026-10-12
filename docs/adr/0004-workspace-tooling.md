# 0004 — pnpm workspace with TypeScript project references (no Turborepo)

**Status:** accepted

**Decision.** Six packages, `tsc -b` for the server packages, `next build` for the web app, pnpm 12 via corepack
with an explicit `allowBuilds` list (native install scripts must be approved). A task runner/cache would add
configuration without measurable benefit at this size; `scripts/dev.mjs` runs the dev processes.

**Consequences.** Simple, reproducible builds; if build times grow, adding Turborepo later is mechanical.
