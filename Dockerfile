FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund --prefer-offline --maxsockets=1 --fetch-retries=0

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN npm install -g @openai/codex@0.132.0 --ignore-scripts --no-audit --no-fund
COPY package*.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY server ./server
COPY scripts ./scripts
COPY prompts ./prompts
COPY schemas ./schemas
COPY shared ./shared
COPY --from=build /app/dist ./dist
EXPOSE 8080
CMD ["node", "server/index.js"]
