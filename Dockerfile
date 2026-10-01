# ============================================================
# SiftGate — Multi-stage Docker build
# ============================================================
# Produces a single image that serves the NestJS backend
# and the pre-built React frontend (via @nestjs/serve-static).
#
# Build:  docker build -t siftgate .
# Run:    docker run -p 2099:2099 -v $(pwd)/gateway.config.yaml:/app/gateway.config.yaml siftgate
# ============================================================

# Match the tested Node 22 runtime. Candidate builds can pin the resolved image
# digest with --build-arg NODE_IMAGE=node@sha256:... for reproducibility.
ARG NODE_IMAGE=node:22-alpine

# ── Stage 1: Build frontend ──
FROM ${NODE_IMAGE} AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# The Dashboard imports shared pricing contracts and browser-safe helpers.
COPY src/ /app/src/
RUN npm run build

# ── Stage 2: Build backend ──
FROM ${NODE_IMAGE} AS backend-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json nest-cli.json ./
COPY src/ ./src/
COPY plugins/ ./plugins/
COPY tsconfig.plugins.json ./
COPY scripts/copy-runtime-assets.js ./scripts/copy-runtime-assets.js
RUN npm run build

# ── Stage 3: Production image ──
FROM ${NODE_IMAGE} AS production
WORKDIR /app

# Install production dependencies only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy built backend
COPY --from=backend-build /app/dist ./dist
COPY --from=backend-build /app/dist-runtime-plugins ./dist-runtime-plugins

# Copy built frontend
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

# Create data directory for SQLite
RUN mkdir -p /app/data

# Default config (user should mount their own)
COPY gateway.config.example.yaml ./gateway.config.yaml
COPY scripts/docker-healthcheck.js ./scripts/docker-healthcheck.js

EXPOSE 2099

# Probe port defaults to 2099. Set SIFTGATE_HEALTHCHECK_PORT when server.port differs.
# This changes only the probe, not the gateway's configured listener or host mapping.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "scripts/docker-healthcheck.js"]

CMD ["node", "dist/main.js"]
