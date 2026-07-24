FROM node:22-bookworm-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/provider/package.json packages/provider/package.json
COPY packages/importers/package.json packages/importers/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm build
RUN pnpm --filter @copilotchat/server deploy --prod /prod/server

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV COPILOTCHAT_HOST=0.0.0.0
ENV COPILOTCHAT_PORT=4317
ENV COPILOTCHAT_DATA_DIR=/data
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini && rm -rf /var/lib/apt/lists/*
RUN addgroup --system copilotchat && adduser --system --ingroup copilotchat copilotchat
WORKDIR /app
COPY --from=build --chown=copilotchat:copilotchat /prod/server ./server
COPY --from=build --chown=copilotchat:copilotchat /app/apps/web/dist ./web/dist
RUN mkdir -p /data && chown copilotchat:copilotchat /data
USER copilotchat
EXPOSE 4317
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:4317/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/dist/index.js"]
