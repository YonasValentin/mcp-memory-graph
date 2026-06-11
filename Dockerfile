# syntax=docker/dockerfile:1.7

# ── Stage 1: build server + web UI ─────────────────────────────────────────
FROM node:22-slim AS builder
WORKDIR /app

# Native toolchain for node-gyp: better-sqlite3 12.x has no usable prebuild on
# this image (npm ci fell back to source build and died on "find Python"), and
# any future native dep hits the same wall. Builder-only; runtime stays slim.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Install server deps (cached layer).
COPY package.json package-lock.json ./
RUN npm ci

# Compile TypeScript.
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Build the React web dashboard. Vite emits to /app/dist/web (see web/vite.config.ts).
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci
COPY web/ ./web/
RUN cd web && npm run build

# Strip dev deps from node_modules so the runtime image inherits a lean tree.
RUN npm prune --omit=dev

# ── Stage 2: runtime ───────────────────────────────────────────────────────
FROM node:22-slim AS runtime

# The compiled better-sqlite3 binary is inherited from the builder's
# node_modules (same base image, same ABI) — no toolchain needed here.

ENV NODE_ENV=production \
    MCP_MEMORY_DB_PATH=/data/memory.db \
    MCP_MEMORY_CONFIG_PATH=/data/config.json \
    HF_HOME=/cache \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app

# Copy production artefacts from the builder, owned by the unprivileged node user.
COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist

# Persistent data and embedding-model cache. Both writable by the node user.
RUN mkdir -p /data /cache && chown -R node:node /data /cache /app

USER node

EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://localhost:3100/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "dist/index.js"]
CMD ["serve"]
