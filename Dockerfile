# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim

# Major version of the PostgreSQL client tools. Set this to EXACTLY the
# server's major version -- check with:  SELECT version();
#
# "Newer client is fine" is only half true. A newer pg_dump can read an
# older server, but it writes an archive the older server cannot restore:
# pg_dump 17 against a PG 15 server emits `SET transaction_timeout = 0`
# (a PG 17-only parameter) and stamps archive format 1.16, so PG 15/16
# pg_restore fails with "unsupported version (1.16) in file header".
# Verified against this project's target cluster.
#
# Default 15 matches the target DigitalOcean cluster. Override in Coolify
# (Build Variables) if you upgrade, e.g. --build-arg PG_MAJOR=16
ARG PG_MAJOR=15

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    STAGING_DIR=/app/staging

# Install postgresql-client from the PGDG repository so the major version
# can be pinned independently of what Debian bookworm happens to ship.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg tzdata; \
    install -d -m 0755 /usr/share/postgresql-common/pgdg; \
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
        -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc; \
    echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
        > /etc/apt/sources.list.d/pgdg.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends "postgresql-client-${PG_MAJOR}"; \
    apt-get purge -y --auto-remove curl gnupg; \
    rm -rf /var/lib/apt/lists/*; \
    pg_dump --version

# Non-root runtime user. A fixed UID/GID keeps ownership of the mounted
# staging volume stable across image rebuilds. The node image ships its own
# `node` user at UID 1000; we use a distinct 10001 so the volume ownership
# documented in the README stays correct regardless of base-image changes.
RUN groupadd --gid 10001 appuser \
 && useradd --uid 10001 --gid 10001 --create-home --shell /bin/bash appuser

WORKDIR /app

# Copy manifests first so the dependency layer is cached independently of
# the application code. npm ci installs exactly what package-lock.json
# pins, which is why the lockfile is committed.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY pg_backup.js restore_test.js ./

# Create the staging tree in the image so a first run works even before a
# volume is attached; when Coolify mounts an empty volume here it inherits
# this ownership, hence the README note about chown-ing an existing volume
# to 10001:10001.
RUN mkdir -p /app/staging/logs \
 && chown -R appuser:appuser /app

USER appuser

# The container must stay alive so Coolify's Scheduled Task and "Execute
# Command" have a running container to exec into. This process does no work
# and holds no connections -- all work happens in the scheduled
# `node pg_backup.js` invocations.
CMD ["tail", "-f", "/dev/null"]
