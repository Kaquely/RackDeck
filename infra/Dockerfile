# syntax=docker/dockerfile:1

# =============================================================================
# Stage 1 — build the frontend
#
# Only the frontend is compiled. The backend is TypeScript executed through Node 24's
# native type stripping, so there is deliberately no backend build stage: the code that
# ships is the same source the tests import, which removes any chance of the artefact
# drifting from what was tested.
# =============================================================================
FROM node:24-alpine AS web

WORKDIR /build

# Dependencies are installed from the lockfile alone, so this layer is cached until a
# dependency actually changes rather than on every source edit.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.base.json tsconfig.json tsconfig.web.json tsconfig.domtest.json ./
COPY vite.config.ts ./
COPY eslint.config.js .prettierrc.json .prettierignore ./
COPY src ./src

RUN npm run build


# =============================================================================
# Stage 2 — runtime
#
# Production dependencies only, so the audit surface is express and systeminformation
# rather than the whole development tree. Runs as a non-root user, holds no credentials
# and mounts no Docker socket: the product observes, it never controls the host.
# =============================================================================
FROM node:24-alpine AS runtime

# Build metadata is baked in by the release workflow. The defaults keep a local
# `docker build` honest: an unlabelled image reports itself as unknown rather than claiming a
# release identity it does not have.
ARG APP_VERSION=0.0.0-unknown
ARG APP_REVISION=unknown
ARG APP_CHANNEL=stable
ARG APP_SOURCE=https://github.com/Kaquely/RackDeck
ARG APP_CREATED=

LABEL org.opencontainers.image.title="RackDeck" \
      org.opencontainers.image.description="Read-only, real-time dashboard for a homelab." \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${APP_REVISION}" \
      org.opencontainers.image.source="${APP_SOURCE}" \
      org.opencontainers.image.created="${APP_CREATED}" \
      org.opencontainers.image.licenses="MIT"

# `tini` gives the process a real init, so SIGTERM reaches Node and the graceful drain in
# src/main.ts actually runs. Without it, PID 1 signal handling in a container is unreliable
# and every restart would be a hard kill.
RUN apk add --no-cache tini

ENV NODE_ENV=production \
    PORT=3000 \
    HOMELABMD_HOST=0.0.0.0 \
    HOMELABMD_DATA_DIR=/data \
    HOMELABMD_STATIC_DIR=/app/dist/web \
    HOMELABMD_COMMIT="${APP_REVISION}" \
    HOMELABMD_CHANNEL="${APP_CHANNEL}"

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Source, unchanged: the runtime strips the types.
COPY --chown=node:node src ./src
# The frontend bundle produced by stage 1.
COPY --from=web --chown=node:node /build/dist ./dist

# The layout document is the only durable state, so it gets its own volume owned by the
# unprivileged user the process runs as.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

USER node

EXPOSE 3000

# The same endpoint the dashboard uses. It never contacts a source, so a source being down
# does not mark the container unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/main.ts"]
