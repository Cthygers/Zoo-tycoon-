# syntax=docker/dockerfile:1.7
# Wildhaven API image. Build from the REPO ROOT (shared/ is compiled into the server):
#   docker build -f server/Dockerfile -t wildhaven-api:local .
# or, from server/: docker compose up -d --build
ARG NODE_IMAGE=node:26.13.1-trixie-slim

# ---- build: compile server/src and shared/ with tsc (rootDir ".." → dist/server/src, dist/shared)
FROM ${NODE_IMAGE} AS build
WORKDIR /repo/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
# shared/*.ts must compile as ES modules: give /repo the same "type": "module" as the repo root.
RUN printf '{ "private": true, "type": "module" }\n' > /repo/package.json
COPY shared/ /repo/shared/
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npx tsc -p tsconfig.json

# ---- deps: production node_modules only
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

# ---- runtime: non-root, read-only friendly (writes only /data and /tmp)
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0 DB_PATH=/data/wildhaven.db BACKUP_DIR=/data/backups
WORKDIR /app
COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /repo/server/dist ./dist
COPY server/package.json ./
COPY server/migrations ./migrations
COPY server/public ./public
RUN mkdir -p /data/backups && chown -R node:node /data
USER node
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node","-e","fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node","--enable-source-maps","dist/server/src/main.js"]
