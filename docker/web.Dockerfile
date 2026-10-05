# syntax=docker/dockerfile:1
# Web image.
#
# Next.js standalone output, so the runtime layer carries only what the app
# actually imports rather than the whole workspace.

# ---------------------------------------------------------------- deps ------
FROM node:22-alpine AS deps
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /repo

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
    pnpm install --frozen-lockfile --filter "@truckdesk/web..." --filter "@truckdesk/docs..."

# ---------------------------------------------------------------- build -----
FROM deps AS build
WORKDIR /repo
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_PUBLIC_API_URL=http://localhost:4000

COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY packages/core/    packages/core/
COPY packages/eld/     packages/eld/
COPY packages/loads/   packages/loads/
COPY packages/llm/     packages/llm/
COPY packages/sms/     packages/sms/
COPY packages/api/     packages/api/
COPY packages/web/     packages/web/

RUN pnpm --filter @truckdesk/shared --filter @truckdesk/core \
        --filter @truckdesk/eld --filter @truckdesk/loads \
        --filter @truckdesk/llm --filter @truckdesk/sms run build \
 && pnpm --filter @truckdesk/web run build

# --------------------------------------------------------------- runtime ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
RUN apk add --no-cache tini && addgroup -S truckdesk && adduser -S truckdesk -G truckdesk
WORKDIR /app

# Next.js `output: 'standalone'` emits a self-contained server under
# `.next/standalone`, including the node_modules it traced.
COPY --from=build --chown=truckdesk:truckdesk /repo/packages/web/.next/standalone ./
COPY --from=build --chown=truckdesk:truckdesk /repo/packages/web/.next/static ./packages/web/.next/static
COPY --from=build --chown=truckdesk:truckdesk /repo/packages/web/public ./packages/web/public

USER truckdesk
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=4s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "packages/web/server.js"]