# syntax=docker/dockerfile:1
# API image.
#
# Multi-stage: the workspace libraries are compiled once here rather than at
# container start, so boot is "node dist/main.js" and nothing else.

# ---------------------------------------------------------------- deps ------
FROM node:22-alpine AS deps
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /repo

# Manifests only, so this layer is cached until a dependency actually changes.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc ./
COPY packages/shared/package.json  packages/shared/
COPY packages/core/package.json     packages/core/
COPY packages/eld/package.json      packages/eld/
COPY packages/loads/package.json    packages/loads/
COPY packages/llm/package.json      packages/llm/
COPY packages/sms/package.json      packages/sms/
COPY packages/api/package.json      packages/api/
COPY packages/web/package.json      packages/web/
COPY packages/docs/package.json     packages/docs/
COPY packages/mobile/package.json   packages/mobile/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@truckdesk/api..." --filter "@truckdesk/web..."

# ---------------------------------------------------------------- build -----
FROM deps AS build
WORKDIR /repo
COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY packages/core/    packages/core/
COPY packages/eld/     packages/eld/
COPY packages/loads/   packages/loads/
COPY packages/llm/     packages/llm/
COPY packages/sms/     packages/sms/
COPY packages/api/     packages/api/

RUN pnpm --filter @truckdesk/shared --filter @truckdesk/core \
        --filter @truckdesk/eld --filter @truckdesk/loads \
        --filter @truckdesk/llm --filter @truckdesk/sms run build \
 && pnpm --filter @truckdesk/api run build

# --------------------------------------------------------------- runtime ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
ENV PORT=4000
ENV HOST=0.0.0.0

# `tini` gives us real signal handling, which matters because the API flushes
# GPS pings and closes the pool on SIGTERM.
RUN apk add --no-cache tini && addgroup -S truckdesk && adduser -S truckdesk -G truckdesk
WORKDIR /repo

COPY --from=build --chown=truckdesk:truckdesk /repo/node_modules ./node_modules
COPY --from=build --chown=truckdesk:truckdesk /repo/package.json ./package.json
COPY --from=build --chown=truckdesk:truckdesk /repo/packages/shared ./packages/shared
COPY --from=build --chown=truckdesk:truckdesk /repo/packages/core    ./packages/core
COPY --from=build --chown=truckdesk:truckdesk /repo/packages/eld     ./packages/eld
COPY --from=build --chown=truckdesk:truckdesk /repo/packages/loads   ./packages/loads
COPY --from=build --chown=truckdesk:truckdesk /repo/packages/llm     ./packages/llm
COPY --from=build --chown=truckdesk:truckdesk /repo/packages/sms     ./packages/sms
COPY --from=build --chown=truckdesk:truckdesk /repo/packages/api/dist ./packages/api/dist
COPY --from=build --chown=truckdesk:truckdesk /repo/packages/api/drizzle ./packages/api/drizzle

USER truckdesk
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=4s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "packages/api/dist/main.js"]