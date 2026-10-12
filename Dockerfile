# syntax=docker/dockerfile:1.7
#
# Project Hub images. One file, three runtime targets:
#   docker build --target api    -t projecthub-api .
#   docker build --target worker -t projecthub-worker .
#   docker build --target web    -t projecthub-web --build-arg API_INTERNAL_URL=http://api:4000 .
# deploy/compose.yaml builds and wires all of them.

ARG NODE_VERSION=24

# ---------------------------------------------------------------- toolchain
FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NEXT_TELEMETRY_DISABLED=1
RUN npm install -g corepack@latest && corepack enable
# Fetch pnpm (and the native binary it downloads on first run) once into this layer, retrying on slow networks,
# instead of in every later RUN step. Keep the version in sync with "packageManager" in package.json.
ARG PNPM_VERSION=12.9.1
RUN corepack install -g pnpm@${PNPM_VERSION} \
 && for i in 1 2 3 4 5; do pnpm --version && break; echo "pnpm download retry $i"; sleep 10; done \
 && pnpm --version
WORKDIR /app

# Manifests only, so dependency layers are cached until a package.json or the lockfile changes.
FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/database/package.json packages/database/
COPY packages/core/package.json packages/core/

# ---------------------------------------------------------------- build everything
FROM manifests AS build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
# Next.js bakes rewrites at build time; they are only a fallback (the reverse proxy routes /api and /git).
ARG API_INTERNAL_URL=http://api:4000
ENV API_INTERNAL_URL=${API_INTERNAL_URL}
RUN pnpm run build

# ---------------------------------------------------------------- production dependencies for api + worker
FROM manifests AS server-deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter "@projecthub/api..." --filter "@projecthub/worker..."
COPY --from=build /app/packages/contracts/dist packages/contracts/dist
COPY --from=build /app/packages/database/dist packages/database/dist
COPY --from=build /app/packages/database/migrations packages/database/migrations
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/worker/dist apps/worker/dist

# ---------------------------------------------------------------- api (REST API, Git over HTTPS, preview gateway)
FROM node:${NODE_VERSION}-bookworm-slim AS api
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production STORAGE_DIR=/data/storage API_PORT=4000 PREVIEW_PORT=4100
WORKDIR /app
COPY --from=server-deps --chown=node:node /app /app
RUN mkdir -p /data/storage && chown node:node /data/storage
USER node
EXPOSE 4000 4100
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/health/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
# Applies pending migrations on start (advisory-locked, safe with several replicas).
CMD ["node", "apps/api/dist/main.js"]

# ---------------------------------------------------------------- worker (builds, previews, deployments, browser, AI)
FROM node:${NODE_VERSION}-bookworm-slim AS worker
# git: repositories · postgresql-client-18: pre-deployment pg_dump backups · Chromium: screenshots and device tests
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tini curl gnupg postgresql-common \
 && /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y \
 && apt-get install -y --no-install-recommends postgresql-client-18 \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production STORAGE_DIR=/data/storage PG_DUMP_BINARY=/usr/bin/pg_dump PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY --from=server-deps --chown=node:node /app /app
RUN cd apps/worker && npx playwright install --with-deps chromium \
 && mkdir -p /data/storage && chown -R node:node /data/storage /ms-playwright
# Project builds run npm/pnpm/yarn inside the workspace; enable the package managers projects declare.
RUN npm install -g corepack@latest && corepack enable
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/worker/dist/main.js"]

# ---------------------------------------------------------------- web (Next.js standalone)
FROM node:${NODE_VERSION}-bookworm-slim AS web
ENV NODE_ENV=production PORT=3100 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:3100/login').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
