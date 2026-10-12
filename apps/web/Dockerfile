# Build context is the repo root (pnpm workspace), not apps/web —
# see apps/web/.dockerignore-relevant root .dockerignore. Coolify: set
# "Base Directory" to "/" and "Dockerfile Location" to "apps/web/Dockerfile".

FROM node:22-alpine AS base
RUN corepack enable

# ---- deps: install only what apps/web needs, using the workspace lockfile ----
FROM base AS deps
WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --frozen-lockfile --filter @athernull/web...

# ---- builder: full source, produce .next/standalone ----
FROM base AS builder
WORKDIR /repo
# The workspace manifest pins pnpm (packageManager) for corepack; without it
# corepack fetches whatever pnpm is latest.
COPY package.json pnpm-workspace.yaml ./
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/web/node_modules ./apps/web/node_modules
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
# pnpm links each workspace package's own dependencies (zod for contracts)
# into that package's node_modules: the source copy above has none.
COPY --from=deps /repo/packages/contracts/node_modules ./packages/contracts/node_modules
COPY apps/web apps/web
ENV NEXT_TELEMETRY_DISABLED=1
# NEXT_PUBLIC_* are inlined at build time. With the API behind the same
# origin (docs/runbooks/vps-deploy.md) this is the site's own origin, e.g.
# https://athernull.io. In Coolify, mark these as build variables.
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_APP_HOME
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_APP_HOME=$NEXT_PUBLIC_APP_HOME
RUN pnpm --filter @athernull/web build

# ---- runner: just the standalone server + static assets ----
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001 -G nodejs

COPY --from=builder --chown=nextjs:nodejs /repo/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /repo/apps/web/public ./apps/web/public

USER nextjs
EXPOSE 3000
ENV PORT=3000
CMD ["node", "apps/web/server.js"]
