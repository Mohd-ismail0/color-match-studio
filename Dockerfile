# Color Match Studio: calibration API + the browser tool it serves.
#
# Production topology: stateless API container, durable state in the shared
# PostgreSQL instance (dedicated database/user). There is no SQLite volume here:
# the container filesystem is disposable.
#
# Node is pinned to the version the API is developed and tested against
# (`engines.node >= 22.12`). The API runtime installs only api/package.json
# dependencies; the SPA is built in its own stage and shipped as static files.

FROM node:22.23.1-bookworm-slim AS deps
WORKDIR /app/api
COPY api/package.json api/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# The public browser surface: load a reference card, correct images locally,
# or copy an LC2- colour code for the API. Built with the repo's own toolchain,
# then only the static output is copied into the runtime image.
FROM node:22.23.1-bookworm-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html vite.config.ts tailwind.config.ts postcss.config.js components.json ./
COPY tsconfig.json tsconfig.app.json tsconfig.node.json tsconfig.api.json ./
COPY public ./public
COPY src ./src
RUN npm run build

FROM node:22.23.1-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=8081 \
    COLOR_API_HOST=0.0.0.0 \
    COLOR_DB_BACKEND=postgres \
    COLOR_DB_MIGRATE=verify \
    COLOR_API_WEB_ROOT=/app/web

WORKDIR /app

# Runtime dependencies (pg, sharp, tsx), then the API and the shared engine it
# imports from src/lib and src/types.
COPY --from=deps --chown=node:node /app/api/node_modules /app/api/node_modules
COPY --chown=node:node api /app/api
COPY --chown=node:node src/lib /app/src/lib
COPY --chown=node:node src/types /app/src/types
COPY --from=web --chown=node:node /app/dist /app/web

# Fail the build early if the pinned runtime cannot execute the TS entrypoint
# toolchain that CMD relies on.
RUN node /app/api/node_modules/tsx/dist/cli.mjs --version

USER node
WORKDIR /app/api
EXPOSE 8081

# Liveness only: /health must answer while image work is in flight. Readiness
# (/ready) additionally proves the PostgreSQL store answers.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8081)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "node_modules/tsx/dist/cli.mjs", "main.ts"]
