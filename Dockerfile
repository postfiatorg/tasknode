ARG NODE_IMAGE=node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund --prefer-offline --maxsockets=1 --fetch-retries=0

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build \
    && node scripts/build-runtime-tree.mjs \
      --entry server/index.js \
      --include server/db/migrations \
      --include docs/wiki/surfaces/user-guide.md \
      --include prompts \
      --exclude prompts/non_production \
      --include schemas \
      --out /runtime-web \
    && node scripts/build-runtime-tree.mjs \
      --entry server/worker-entry.js \
      --entry scripts/hive-board-secretary-worker.mjs \
      --entry scripts/migrate-db.mjs \
      --include server/db/migrations \
      --include prompts \
      --exclude prompts/non_production \
      --include schemas \
      --out /runtime-worker

FROM ${NODE_IMAGE} AS web-production-deps
WORKDIR /app
COPY runtime/web/package*.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund --prefer-offline --maxsockets=1 --fetch-retries=0

FROM ${NODE_IMAGE} AS worker-production-deps
WORKDIR /app
COPY runtime/worker/package*.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund --prefer-offline --maxsockets=1 --fetch-retries=0

FROM ${NODE_IMAGE} AS compatibility-production-deps
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
RUN npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM ${NODE_IMAGE} AS runtime-base
WORKDIR /app
ENV NODE_ENV=production
RUN apk upgrade --no-cache \
    && rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    && mkdir -p /data \
    && chown node:node /data
USER node

FROM runtime-base AS web-runtime
COPY runtime/web/package.json ./package.json
COPY --from=web-production-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=build /runtime-web ./
COPY --chown=node:node --from=build /app/dist ./dist
EXPOSE 8080
CMD ["node", "server/index.js"]

FROM runtime-base AS worker-runtime
COPY runtime/worker/package.json ./package.json
COPY --from=worker-production-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=build /runtime-worker ./
CMD ["node", "server/worker-entry.js"]

# Compatibility default for existing single-image multi-process deployments.
# Public deployments should select web-runtime and worker-runtime explicitly.
FROM runtime-base AS runtime
COPY package*.json ./
COPY --from=compatibility-production-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=build /runtime-web ./
COPY --chown=node:node --from=build /runtime-worker ./
COPY --chown=node:node --from=build /app/dist ./dist
EXPOSE 8080
CMD ["node", "server/index.js"]
