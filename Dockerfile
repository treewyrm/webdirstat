# syntax=docker/dockerfile:1

FROM node:24-alpine AS base
RUN corepack enable && corepack prepare pnpm@11.8.0 --activate
WORKDIR /app

# ---- deps + build (dev deps included) ----
FROM base AS builder

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY shared/package.json ./shared/package.json
COPY server/package.json ./server/package.json
COPY client/package.json ./client/package.json

RUN pnpm install --frozen-lockfile

COPY shared ./shared
COPY server ./server
COPY client ./client

RUN pnpm --filter ./client run build
RUN pnpm --filter ./server run build

# ---- production dependencies only ----
FROM base AS prod-deps

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY shared/package.json ./shared/package.json
COPY server/package.json ./server/package.json

RUN pnpm install --prod --frozen-lockfile --filter @webdirstat/server...

# ---- final runtime image ----
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/server/node_modules ./server/node_modules
COPY --from=prod-deps /app/shared ./shared
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/client/dist ./client-dist

ENV PORT=8080
ENV HOST=0.0.0.0
ENV CLIENT_DIST=/app/client-dist
ENV ROOTS=Data=/data
# The SQLite store must live on WRITABLE storage — never the read-only scanned share.
ENV DB_PATH=/db/webdirstat.db

# Writable store dir, owned by the unprivileged runtime user before it becomes a volume.
RUN mkdir -p /db && chown node:node /db

EXPOSE 8080
# /data: read-only scanned share(s). /db: writable store.
VOLUME ["/data", "/db"]

# Orchestrator probe. Node's global fetch (24+) avoids depending on wget's status handling;
# shell form so $PORT expands. Non-2xx (e.g. 503 when the store is unreachable) exits 1.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node
CMD ["node", "server/dist/index.js"]
