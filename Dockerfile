# ── PureGate Knowledge Server ──────────────────────────────────────────────

FROM node:20-slim AS builder

WORKDIR /app

# Install build dependencies
COPY package.json package-lock.json* ./
RUN npm install

# Build TypeScript
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Production image ──────────────────────────────────────────────────────

FROM node:20-slim AS production

WORKDIR /app

# Install production dependencies only
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

# Copy built files
COPY --from=builder /app/dist/ ./dist/

# Create non-root user
RUN groupadd -r puregate && useradd -r -g puregate puregate
RUN mkdir -p /data && chown puregate:puregate /data
USER puregate

# Environment defaults
ENV SERVER_MODE=http \
    PORT=3000 \
    HOST=0.0.0.0 \
    DB_PROVIDER=postgres \
    LOG_LEVEL=info \
    NODE_ENV=production

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health/live').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["node", "dist/index.js"]
