# ──────────────────────────────────────────────────────────────
# Hydra UI — production image
# Multi-stage build producing a minimal `next start`-ready image
# from Next.js standalone output. Runs as non-root `hydra` user.
# Build context is the repo root.
# ──────────────────────────────────────────────────────────────

FROM node:20-alpine AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/bot/package.json ./packages/bot/
COPY packages/ui/package.json ./packages/ui/
RUN pnpm fetch

FROM node:20-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
COPY --from=deps /app /app
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY packages/ui ./packages/ui
RUN pnpm install --offline --filter @hydra/shared... --filter @hydra/ui...
RUN pnpm --filter @hydra/shared build && pnpm --filter @hydra/ui build

FROM node:20-alpine AS runtime
WORKDIR /app
RUN addgroup -S hydra && adduser -S hydra -G hydra \
 && apk add --no-cache wget
# Next standalone output bundles node_modules it actually uses.
# We copy from the build stage to the expected layout.
COPY --from=build --chown=hydra:hydra /app/packages/ui/.next/standalone ./
COPY --from=build --chown=hydra:hydra /app/packages/ui/.next/static ./packages/ui/.next/static
COPY --from=build --chown=hydra:hydra /app/packages/ui/public ./packages/ui/public
USER hydra
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:3000/ || exit 1
CMD ["node", "packages/ui/server.js"]
