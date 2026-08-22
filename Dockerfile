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
ENV NEXT_TELEMETRY_DISABLED=1

# Placeholders, needed only so the build can run.
#
# Collecting page configuration imports the server modules, which constructs
# the Prisma client, which reads the validated environment — so the build fails
# without these even though it never opens a connection. On a developer's
# machine .env supplied them invisibly; the first container build is where that
# showed up.
#
# None of these reach the running image: the runtime stage below is a separate
# FROM and inherits no ENV from here. Real values are supplied at run time, and
# `instrumentation.ts` asserts them at boot, so a container started without
# them fails immediately and loudly rather than serving traffic.
#
# The production-only hardening checks (placeholder secret, https, rate-limit
# driver) stand down during the build phase — see the note in lib/env.ts.
ENV DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build?schema=public"
ENV AUTH_SECRET="build-time-placeholder-never-used-at-runtime-0000"
ENV APP_URL="http://localhost:3000"

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
# The application drains on SIGTERM — stops reporting ready, keeps serving
# while the balancer notices, then closes the database and exits. Next installs
# its own SIGTERM handler before the application is loaded, and that one closes
# the socket and exits immediately; with it in place the drain got twelve
# milliseconds of a fifteen-second window. This is Next's documented way to say
# the process handles its own termination. See src/server/lifecycle.ts.
ENV NEXT_MANUAL_SIG_HANDLE=1

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
