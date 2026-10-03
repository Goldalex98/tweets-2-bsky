# syntax=docker/dockerfile:1.7

FROM oven/bun:1.4.2-slim AS build

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY bun.lock ./bun.lock
COPY scripts ./scripts

RUN bun install --frozen-lockfile

COPY . .

RUN bun run build \
  && bun install --frozen-lockfile --production


FROM oven/bun:1.4.2-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production \
  HOST=0.0.0.0 \
  PORT=3000 \
  TWEETS2BSKY_DATA_DIR=/app/data \
  CHROME_BIN=/usr/bin/chromium \
  PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    tini \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/bun.lock ./bun.lock
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/public ./public
COPY --from=build /app/scripts/image-runtime-smoke.ts ./scripts/image-runtime-smoke.ts
COPY --from=build /app/scripts/image-data-smoke.ts ./scripts/image-data-smoke.ts
COPY --from=build /app/scripts/image-data-invariants.ts ./scripts/image-data-invariants.ts
COPY --from=build /app/scripts/image-copied-volume-smoke.ts ./scripts/image-copied-volume-smoke.ts
COPY --from=build /app/tests/fixtures/config-v*-*.json ./scripts/fixtures/

COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/tweets2bsky-entrypoint

RUN mkdir -p /app/data \
  && chown 1000:1000 /app/data \
  && ln -sf /app/data/config.json /app/config.json

VOLUME ["/app/data"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 CMD ["bun", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/readyz').then((res) => process.exit(res.ok ? 0 : 1)).catch(() => process.exit(1))"]

# Starts as root only long enough to fix data volume ownership, then runs as bun (uid 1000).
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/tweets2bsky-entrypoint"]
CMD ["bun", "dist/index.js"]
