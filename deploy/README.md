# Running Project Hub in production

> **Validation status:** the images and this compose stack have not been built or started yet (they were written on
> a machine without a container runtime). Every service they run is tested, and the production web build was
> verified, but bring the stack up on a staging host first.

## What you need

- A Linux host with Docker Engine 24+ and the Compose plugin (8 GB RAM / 200 GB disk is the sizing target).
- DNS: `hub.example.com` and `*.preview.hub.example.com` pointing at the host; ports 80 and 443 open.
- A DNS provider supported by Traefik for the wildcard preview certificate (Let's Encrypt only issues wildcards
  through a DNS-01 challenge), plus an API token for it.

## First start

```bash
cp deploy/.env.production.example deploy/.env      # domain, ACME e-mail, DNS provider, secrets
printf 'CF_DNS_API_TOKEN=...\n' > deploy/.env.dns   # credentials variable(s) of your DNS provider
docker compose -f deploy/compose.yaml --env-file deploy/.env up -d --build
docker compose -f deploy/compose.yaml --env-file deploy/.env exec ollama ollama pull qwen2.5-coder:7b
docker compose -f deploy/compose.yaml --env-file deploy/.env exec api \
  node packages/core/dist/cli/create-admin.js --email you@company.com --name "Ad Soyad" --org "Şirket Adı"
```

The API applies database migrations on start (guarded by an advisory lock). Ollama is private to the Compose
network and persists weights in `ollama_data`; it has no published host port. Sign in at
`https://hub.example.com`, then in *Yönetim*: verify the local model, invite people, and review retention and
capacity. Cloud provider keys are optional and disabled when left empty.

## Local staging (no domain, no certificates)

`deploy/compose.staging.yaml` runs the same images, networks, volumes and health checks on one workstation:
Traefik on `127.0.0.1:8443` only (self-signed certificate, no ACME), the project name `projecthub-staging` (separate
volumes) and the host's Ollama instead of the bundled one.

```bash
mkdir -p .data/staging
node -e "const c=require('crypto');console.log(['PH_DOMAIN=localhost','PH_DOMAIN_REGEX=localhost','POSTGRES_PASSWORD='+c.randomBytes(18).toString('hex'),'APP_ENCRYPTION_KEY='+c.randomBytes(32).toString('base64'),'ACME_EMAIL=staging@localhost','ACME_DNS_PROVIDER=none','OLLAMA_MODEL=qwen3:8b'].join('\n'))" > .data/staging/.env
S="docker compose -f deploy/compose.yaml -f deploy/compose.staging.yaml --env-file .data/staging/.env"
$S up -d --build                       # api applies migrations on start
$S ps                                  # postgres/api/web healthy; worker running; only 127.0.0.1:8443 published
$S exec -e PH_ADMIN_PASSWORD='…' api node packages/core/dist/cli/create-admin.js --email you@company.com --name "Ad Soyad" --org "Staging"
# open https://localhost:8443 (accept the self-signed certificate)
$S down                                # keeps volumes; add -v only to wipe the staging data
```

## Backup and restore drill

Run this on a staging copy, never against production data. It proves a backup can actually be restored:

```bash
S="docker compose -f deploy/compose.yaml -f deploy/compose.staging.yaml --env-file .data/staging/.env"
$S exec -T postgres pg_dump -U projecthub -Fc projecthub > drill.dump
$S exec -T postgres createdb -U projecthub projecthub_drill
$S exec -T postgres pg_restore -U projecthub -d projecthub_drill --no-owner --exit-on-error < drill.dump
# compare row counts per table and the audit chain, then:
$S exec -T postgres dropdb -U projecthub projecthub_drill
```

For storage, restore `storage.tgz` into an empty directory and run `git fsck` on every `repos/*.git`.

## Generate secrets

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # APP_ENCRYPTION_KEY
openssl rand -base64 24                                                       # POSTGRES_PASSWORD
```

`APP_ENCRYPTION_KEY` encrypts project secrets, deployment credentials and review links. Keep it with the backups:
without it those values cannot be decrypted.

## Backups

Back up the database and storage together. The optional third command preserves model weights (otherwise they can
be pulled again):

```bash
docker compose -f deploy/compose.yaml exec -T postgres pg_dump -U projecthub -Fc projecthub > projecthub.dump
docker run --rm -v projecthub_storage:/data -v "$PWD":/backup busybox tar czf /backup/storage.tgz -C /data .
docker run --rm -v projecthub_ollama_data:/data -v "$PWD":/backup busybox tar czf /backup/ollama-models.tgz -C /data .
```

The storage volume holds the Git repositories (the source of truth for code), build artifacts and pre-deployment
database backups of managed projects.

## Upgrades

```bash
git pull
docker compose -f deploy/compose.yaml --env-file deploy/.env up -d --build
```

On shutdown the worker stops taking jobs and gives running ones up to 50 s (the container has a 60 s grace
period). Anything still running is re-queued and starts again from the beginning on the new worker: a build reruns,
a deployment repeats its steps. A deployment never leaves the site half-updated — the new release is uploaded next
to the live one and swapped in with two renames — but avoid upgrading while a production deployment is running.

## Deployment targets from inside containers

- **SFTP / SSH / FTP(S)** targets are reached over the network from the worker.
- The **local folder** adapter writes inside the container. To publish to a host directory, bind-mount it into the
  worker (and api) and list the in-container path in `DEPLOY_LOCAL_ROOTS`.
- Pre-deployment backups use `pg_dump` 18 from the worker image; the target database must be reachable from it.

## Operating notes

- *Altyapı ve sistem sağlığı* shows memory, disk, storage per category, worker liveness, queues and failed jobs
  (with retry).
- Keep `BUILD_CONCURRENCY` (worker processes) and *Saklama ve kapasite → Eşzamanlı build* (per organization) at 1–2
  on an 8 GB host.
- Builds run as processes inside the worker container, not in per-build containers — read
  [ADR 0005](../docs/adr/0005-build-isolation.md) before importing untrusted code. A standalone worker can opt into
  the constrained per-command runner with `BUILD_EXECUTOR=container`; the Compose worker intentionally has no
  Docker socket and keeps `BUILD_EXECUTOR=host`.
- App previews are told to listen on `127.0.0.1` (`HOST`), but an app that ignores `HOST` binds every interface.
  In this compose stack the preview ports are never published, so only the gateway reaches them. On a host
  without containers, firewall `PREVIEW_PORT_RANGE` (default 41000–41999) from the network.
