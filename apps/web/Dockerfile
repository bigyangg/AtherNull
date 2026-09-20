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
RUN pnpm install --frozen-lockfile --filter @athernull/web...

# ---- builder: full source, produce .next/standalone ----
FROM base AS builder
WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/web/node_modules ./apps/web/node_modules
COPY tsconfig.base.json ./
COPY apps/web apps/web
ENV NEXT_TELEMETRY_DISABLED=1
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
