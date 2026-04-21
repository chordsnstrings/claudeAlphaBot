# ──────────────────────────────────────────────────────────────
# Hydra bot — production image
# Multi-stage build so the final image ships only runtime deps
# + compiled JS. Runs as non-root `hydra` user.
# Build context must be the repo root (so migrations/ + all
# packages/ are reachable).
# ──────────────────────────────────────────────────────────────

# ── deps: resolve workspace deps once, cached ─────────────────
FROM node:20-alpine AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/bot/package.json ./packages/bot/
COPY packages/ui/package.json ./packages/ui/
# Fetch-only step so the CI cache key is the lockfile alone.
RUN pnpm fetch

# ── build: compile shared + bot ───────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
COPY --from=deps /app /app
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY packages/bot ./packages/bot
COPY migrations ./migrations
RUN pnpm install --offline --filter @hydra/shared... --filter @hydra/bot...
RUN pnpm --filter @hydra/shared build && pnpm --filter @hydra/bot build

# ── runtime: strip to prod deps + dist ────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate \
 && addgroup -S hydra && adduser -S hydra -G hydra \
 && apk add --no-cache wget
COPY --from=build --chown=hydra:hydra /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build --chown=hydra:hydra /app/packages/shared/package.json ./packages/shared/
COPY --from=build --chown=hydra:hydra /app/packages/bot/package.json ./packages/bot/
COPY --from=build --chown=hydra:hydra /app/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=hydra:hydra /app/packages/bot/dist ./packages/bot/dist
# Bot reads migration SQL at runtime from /app/migrations.
COPY --from=build --chown=hydra:hydra /app/migrations ./migrations
RUN pnpm install --prod --offline --filter @hydra/bot... --ignore-scripts \
 && pnpm store prune
USER hydra
ENV NODE_ENV=production
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:8080/health || exit 1
CMD ["node", "packages/bot/dist/main.js"]
