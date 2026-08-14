# syntax=docker/dockerfile:1.7

# Retail Intelligence AI — production image.
#
# Four stages, so the thing that ends up running holds no build tools, no
# development dependencies and no source: a Node runtime, the standalone
# server Next.js emitted, the Prisma engine and the migrations.
#
# Debian slim rather than Alpine. Prisma's query engine is a native binary and
# the musl build has historically been the source of "works locally, segfaults
# in the cluster" — a saving of thirty megabytes is not worth that class of
# bug in something that posts financial records.

# -----------------------------------------------------------------------------
# 1. Dependencies
# -----------------------------------------------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app

# openssl is what the Prisma engine links against; ca-certificates is what
# anything making an outbound TLS connection needs.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# The lockfile alone, so this layer is rebuilt only when dependencies change
# rather than on every edit to a component.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# -----------------------------------------------------------------------------
# 2. Build
# -----------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app

COPY . .

# The client has to be generated before the build: every server module imports
# it, and `--ignore-scripts` above deliberately skipped the postinstall that
# would otherwise have done it at a moment when the schema was not yet copied.
RUN npx prisma generate

# NEXT_TELEMETRY_DISABLED: a build should not phone home.
# The build runs with NODE_ENV=production and imports server modules, so the
# environment validator runs — see the note in lib/env.ts about why the
# production-only hardening checks stand down during the build phase.
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# -----------------------------------------------------------------------------
# 3. Runtime
# -----------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runner
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Never root. A process that posts other people's accounts should not also be
# able to rewrite the filesystem it runs on.
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs

# The standalone server, and the assets it serves.
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public

# Migrations and the schema travel with the image, so the release command can
# apply them without a second artefact that might not match the code.
COPY --from=build --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=build --chown=nextjs:nodejs /app/node_modules/prisma ./node_modules/prisma
COPY --from=build --chown=nextjs:nodejs /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=build --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build --chown=nextjs:nodejs /app/node_modules/.bin ./node_modules/.bin

USER nextjs
EXPOSE 3000

# Liveness only — deliberately not the readiness endpoint. A container that
# restarts because Postgres blinked turns a database blip into an application
# outage as well. Readiness belongs to the orchestrator's own probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
