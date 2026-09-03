# syntax=docker/dockerfile:1.7
# One Dockerfile, two targets: api and worker.
# Same as dev: TypeScript runs directly via tsx, no build step. Migrations reuse the api image
# with an overridden command (see deploy/docker-compose.yml).
#
#   docker build --target api    -t nimplex-api .
#   docker build --target worker -t nimplex-worker .

FROM node:22-bookworm-slim AS base
ENV CI=1 NODE_ENV=production
RUN npm install -g pnpm@10.30.3
WORKDIR /app

# Install the whole workspace at once: the lockfile's importers must match the workspace exactly,
# so copying only a subset of packages would break --frozen-lockfile.
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod=false

FROM base AS api
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["pnpm", "--filter", "@nimplex/api", "start"]

FROM base AS worker
CMD ["pnpm", "--filter", "@nimplex/worker", "start"]
