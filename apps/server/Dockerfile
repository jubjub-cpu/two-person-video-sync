# Build from the monorepo root:
#   docker build -f apps/server/Dockerfile -t watch-sync-server .
FROM node:24.18.0-alpine3.23 AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json .npmrc ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY apps/server/package.json apps/server/package.json
RUN pnpm install --frozen-lockfile --filter @watch-sync/server...

COPY packages/protocol packages/protocol
COPY apps/server apps/server
RUN pnpm --filter @watch-sync/protocol build \
    && pnpm --filter @watch-sync/server build \
    && pnpm --filter @watch-sync/server deploy --prod --legacy /opt/watch-sync

FROM node:24.18.0-alpine3.23 AS runtime
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787
WORKDIR /app
COPY --from=build --chown=node:node /opt/watch-sync/ ./
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/index.js"]
