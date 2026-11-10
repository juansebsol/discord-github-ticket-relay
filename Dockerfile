# syntax=docker/dockerfile:1

ARG BUILD_IMAGE=dhi.io/node:24-debian-dev
ARG RUNTIME_IMAGE=dhi.io/node:24

################################################################################
# Build stage: compiles TypeScript and bundles web assets
FROM ${BUILD_IMAGE} AS build
WORKDIR /app

# Copy dependency manifests
COPY package.json package-lock.json ./

# Install dependencies without running build scripts (uses precompiled native modules)
RUN npm ci --ignore-scripts

# Copy application source code and configuration
COPY tsconfig.json ./
COPY src ./src

# Compile TypeScript and copy migration/web assets
RUN npm run build

# Prune development dependencies so only production modules remain
RUN npm prune --omit=dev --ignore-scripts

# Create data directory structure for SQLite db and file attachments
RUN mkdir -p /app/data/files

################################################################################
# Runtime stage: Docker Hardened Node.js image (minimal, non-root)
FROM ${RUNTIME_IMAGE} AS final
WORKDIR /app

# Copy production node_modules, compiled dist, and package metadata
COPY --from=build --chown=1000:1000 /app/node_modules ./node_modules
COPY --from=build --chown=1000:1000 /app/dist ./dist
COPY --from=build --chown=1000:1000 /app/package.json ./package.json
COPY --from=build --chown=1000:1000 /app/data ./data

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATABASE_PATH=/app/data/ticket-relay.db \
    FILES_DIR=/app/data/files

VOLUME ["/app/data"]

EXPOSE 3000

USER 1000:1000

ENTRYPOINT ["node"]
CMD ["dist/index.js"]
