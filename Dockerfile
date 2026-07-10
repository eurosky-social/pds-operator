FROM node:22-slim AS web
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:22-slim AS server
WORKDIR /app/server
# toolchain in case better-sqlite3 has no prebuild for this platform
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY server/package*.json ./
RUN npm ci
COPY server/ ./
RUN npm run build && npm prune --omit=dev
# labelers.json is gitignored instance config; fresh clones build with the example
RUN [ -f labelers.json ] || cp labelers.json.example labelers.json

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app/server
COPY --from=server /app/server/node_modules ./node_modules
COPY --from=server /app/server/dist ./dist
COPY --from=server /app/server/package.json ./package.json
COPY --from=server /app/server/labelers.json ./labelers.json
COPY --from=web /app/web/dist /app/web/dist
EXPOSE 8787
CMD ["node", "dist/index.js"]
