# `projecthub.yml` reference

`projecthub.yml` at the repository root tells Project Hub how to install, build, test, preview, migrate and deploy
a project. When it is missing, Smart Import detects the project (Node/pnpm/yarn/bun, PHP/Laravel, Python, Go,
Java, .NET, static sites) and uses a derived manifest; you can review and save it to the repository under
*Ayarlar ve üyeler → projecthub.yml*. The schema is enforced (`packages/contracts/src/manifest.ts`); invalid files
are reported instead of being half-applied.

```yaml
project:
  name: Nova Mağaza          # display name
  slug: nova-magaza          # informational; the hub's slug is set at import
  version: 1.2.0             # suggested starting point for versions
runtime:
  type: node                 # node | python | php | go | java | dotnet | static | other
  version: "22"
install:
  command: npm ci
build:
  command: npm run build
  output: dist               # build output to publish/preview (static sites)
  timeoutMinutes: 20         # 1–120
test:
  command: npm test          # a failing test fails the build
start:
  command: npm start         # app previews; $PORT / ${PORT} / %PORT% is replaced; PORT and HOST=127.0.0.1 are set —
                             # bind to HOST so the app is only reachable through the authenticated preview gateway
  port: 3000
health:
  path: /api/health          # previews wait for it; deployments check it and roll back on failure
database:
  type: postgresql           # postgresql | mysql | mongodb | sqlite | none
  migrate:
    command: npm run migrate # run during deployment (with DATABASE_URL from the environment's connection/secrets)
    directory: db/migrations # new files are registered per version (checksum, risk) and tracked per environment
preview:
  enabled: true
  ttl: 24h                   # 30m, 24h, 7d …
  mode: process              # static | process (auto-detected when omitted)
  spa: false                 # static previews: serve index.html for unknown paths
deploy:
  source: dist               # folder uploaded to the target (default: build.output, else repo root)
  exclude: [tests]           # extra folders left out (.git, .env and — for remote targets — node_modules always are)
smoke:
  paths: [/, /api/health]    # must answer < 400 after a deployment, otherwise automatic rollback
env:
  - name: DATABASE_URL
    required: true           # previews refuse to start without a secret for it; deployments warn
    description: Sipariş veritabanı
security:
  dependencyScan: true       # OSV.dev vulnerability lookup of lockfile packages
  secretScan: true           # hard-coded credentials
ai:
  indexing: true             # false: the code is not indexed for the AI assistant's context (confidential code)
  autonomy: L2               # caps the organization's AI level for this project (L0 turns AI off here)
```

## Behaviour notes

- **Secrets** come from *Secret'lar* (never from the repository). *Build* secrets reach build commands, *Çalışma*
  secrets reach app previews, *Deployment* secrets reach migrations and SSH post-deploy commands; *Tümü* means all
  three. A value scoped to one environment overrides the project-wide value in that environment's deployment.
- **Deployments** are always a version (an immutable successful build). Steps: policy → artifact → package →
  backup → migration → upload + atomic swap → post-deploy command (SSH) → health → smoke → record. A failed health
  or smoke check restores the previous release automatically; database migrations are never reverted
  automatically — restore from the pre-deployment backup if needed.
- **AI levels**: L0 off · L1 reads and explains · L2 prepares changes on an `ai/…` branch with a verification
  build and waits for approval · L3 additionally opens a preview of the change. AI never deploys or merges.
