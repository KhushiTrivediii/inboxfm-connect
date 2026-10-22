FROM node:24.14.0-bullseye-slim AS base

# Set environment variables early for better layer caching
ENV LANG=en_US.UTF-8 \
    LANGUAGE=en_US:en \
    LC_ALL=en_US.UTF-8

# Install all system dependencies in a single layer with cache mounts
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && \
    apt-get install -y --no-install-recommends \
        openssh-client \
        python3 \
        g++ \
        build-essential \
        git \
        poppler-utils \
        poppler-data \
        procps \
        locales \
        unzip \
        curl \
        ca-certificates \
        iptables \
        libcap-dev && \
    yarn config set python /usr/bin/python3 && \
    sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && \
    locale-gen en_US.UTF-8

RUN export ARCH=$(uname -m) && \
    if [ "$ARCH" = "x86_64" ]; then \
      curl -fSL https://github.com/oven-sh/bun/releases/download/bun-v1.3.3/bun-linux-x64-baseline.zip -o bun.zip; \
    elif [ "$ARCH" = "aarch64" ]; then \
      curl -fSL https://github.com/oven-sh/bun/releases/download/bun-v1.3.3/bun-linux-aarch64.zip -o bun.zip; \
    fi

RUN unzip bun.zip \
    && mv bun-*/bun /usr/local/bin/bun \
    && chmod +x /usr/local/bin/bun \
    && rm -rf bun.zip bun-*

RUN bun --version

# Install global npm packages in a single layer
RUN --mount=type=cache,target=/root/.npm \
    npm install -g --no-fund --no-audit \
    node-gyp \
    npm@11.11.0 \
    pm2@6.0.10 \
    typescript@4.9.4 \
    esbuild@0.25.0

# Install isolated-vm globally (needed for sandboxes)
RUN --mount=type=cache,target=/root/.bun/install/cache \
    cd /usr/src && bun install isolated-vm@6.0.2

### STAGE 1: Build ###
FROM base AS build

WORKDIR /usr/src/app

# Copy dependency files and workspace package.json files for resolution
COPY .npmrc package.json bun.lock bunfig.toml ./
COPY packages/ ./packages/

# Install all dependencies with frozen lockfile
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

# Copy remaining source code (turbo config, etc.)
COPY . .

# Release/environment identifiers for the Sentry source-map upload below. Not
# secret (they end up in the image tag/deploy logs anyway), so plain ARGs are fine.
ARG SENTRY_ORG
ARG SENTRY_PROJECT
ARG SENTRY_RELEASE
ARG SENTRY_ENVIRONMENT

# The web build emits hidden source maps (vite build.sourcemap='hidden') used to
# symbolicate production stack traces in Sentry. The @sentry/vite-plugin wired into
# packages/web/vite.config.ts uploads them to Sentry as part of `vite build` itself,
# tagged with SENTRY_RELEASE/SENTRY_ENVIRONMENT, whenever SENTRY_AUTH_TOKEN is
# present — self-hosted builds (and any CI run without the secret configured) don't
# have it, so the plugin logs a line and no-ops: zero-setup, build still succeeds.
#
# SENTRY_AUTH_TOKEN is passed as a BuildKit secret (not ARG/ENV) so it is mounted
# only for this RUN instruction and never persisted into an image layer, `docker
# history`, or the build cache.
# Build frontend, engine, and server API (there is no standalone worker package in
# the current layout; the unified image runs app/worker modes via AP_CONTAINER_TYPE)
RUN --mount=type=secret,id=sentry_auth_token \
    SENTRY_ORG="$SENTRY_ORG" \
    SENTRY_PROJECT="$SENTRY_PROJECT" \
    SENTRY_RELEASE="$SENTRY_RELEASE" \
    SENTRY_ENVIRONMENT="$SENTRY_ENVIRONMENT" \
    SENTRY_AUTH_TOKEN="$(cat /run/secrets/sentry_auth_token 2>/dev/null || true)" \
    npx turbo run build --filter=@inboxfm-connect/web --filter=@inboxfm-connect/engine --filter=api

# Always strip .map files from the shipped image, independent of whether the
# upload above ran — source is never served from the runtime image (self-hosted too).
RUN find dist/packages/web -name '*.map' -delete

# Generate migration manifest (ordered list of migration names) for image-tag-based rollback
RUN node -e "\
  const {getMigrations} = require('./packages/server/api/dist/src/app/database/postgres-connection');\
  const names = getMigrations().map(M => new M().name);\
  process.stdout.write(JSON.stringify(names));\
" > packages/server/api/dist/src/migration-manifest.json

# Remove integrations not needed at runtime. Pieces are distributed as registry/npm
# tarballs (ADR 0002) and installed into the sandbox cache on first use, so the image
# only ships the integrations the app links against: pieces-framework + pieces-common
# (api runtime deps) and the 4 community pieces the api declares as workspace
# devDependencies. Core pieces are registry-distributed like every other piece.
# Then regenerate bun.lock so it matches the trimmed workspace.
RUN rm -rf packages/integrations/core packages/integrations/custom && \
    find packages/integrations/community -mindepth 1 -maxdepth 1 -type d \
      ! -name slack \
      ! -name square \
      ! -name facebook-leads \
      ! -name intercom \
      -exec rm -rf {} + && \
    rm -f bun.lock && bun install

### STAGE 2: Run ###
FROM base AS run

WORKDIR /usr/src/app

# Copy static configuration files first (better layer caching)
COPY --from=build /usr/src/app/packages/server/api/src/assets/default.cf /usr/local/etc/isolate
COPY docker-entrypoint.sh .

# Create all necessary directories in one layer
RUN mkdir -p \
    /usr/src/app/dist/packages/engine && \
    chmod +x docker-entrypoint.sh

# Copy root config files needed for dependency resolution
COPY --from=build /usr/src/app/package.json ./
COPY --from=build /usr/src/app/.npmrc ./
COPY --from=build /usr/src/app/bun.lock ./
COPY --from=build /usr/src/app/bunfig.toml ./
COPY --from=build /usr/src/app/LICENSE .

# Copy workspace package.json files (needed for bun workspace resolution)
COPY --from=build /usr/src/app/packages ./packages

# Copy built engine
COPY --from=build /usr/src/app/dist/packages/engine/ ./dist/packages/engine/

# Regenerate lockfile and install production dependencies (pieces were trimmed from workspace)
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --production

# Copy frontend files
COPY --from=build /usr/src/app/dist/packages/web ./dist/packages/web/

LABEL service=activepieces

# WORKER containers have no HTTP server; treat them as healthy (probe only the app).
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=5 \
    CMD [ "$AP_CONTAINER_TYPE" = "WORKER" ] && exit 0 || curl -fsS "http://localhost:${AP_PORT:-80}/api/v1/health" || exit 1

ENTRYPOINT ["./docker-entrypoint.sh"]
EXPOSE 80
