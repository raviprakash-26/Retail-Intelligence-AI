#!/usr/bin/env bash
#
# Take a backup of the ledger.
#
# Custom format (-Fc) rather than plain SQL: it is compressed, it can be
# restored selectively, and pg_restore can list its contents — which is what
# makes the verification below possible at all. A plain .sql file can only be
# checked by running it.
#
# The dump is verified before it is kept. A pg_dump that exits 0 having written
# a truncated file is the ordinary way a backup turns out to be worthless, and
# the only cheap defence is to read the thing back and count what is in it.
set -Eeuo pipefail

BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

# Prisma's DATABASE_URL carries `?schema=`, which libpq does not understand and
# rejects outright — "invalid URI query parameter". Every URL in this project
# has it, so stripping that one parameter is the difference between these
# scripts working for everybody and working for nobody. Anything else in the
# query string (sslmode and friends) is libpq's own and is kept.
libpq_url() {
  printf '%s' "$1" | sed -E 's/([?&])schema=[^&]*&?/\1/; s/[?&]$//'
}

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "backup: DATABASE_URL is not set" >&2
  exit 2
fi

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "backup: pg_dump not found. Install the postgresql-client package." >&2
  exit 2
fi

mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="${BACKUP_DIR}/riai-${stamp}.dump"

# Written under a temporary name and renamed only once it has been read back.
# pg_dump creates its output file before it can fail, so dumping straight to
# the final name leaves a partial file that looks exactly like a backup — and a
# file that looks like a backup is worse than no file at all.
partial="${target}.partial"
trap 'rm -f "$partial"' EXIT

# --no-owner and --no-acl so the dump restores into a database owned by
# whoever is doing the restoring, which during an incident is rarely the same
# role that took it.
pg_dump --format=custom --no-owner --no-acl --file="$partial" "$(libpq_url "$DATABASE_URL")"

# Verify before trusting. An empty or truncated dump lists no tables.
tables="$(pg_restore --list "$partial" 2>/dev/null | grep -c 'TABLE DATA' || true)"
if [[ "${tables:-0}" -lt 1 ]]; then
  echo "backup: dump contains no table data — refusing to keep it" >&2
  exit 1
fi

mv "$partial" "$target"
trap - EXIT

bytes="$(wc -c <"$target" | tr -d ' ')"
echo "backup: wrote ${target} (${bytes} bytes, ${tables} tables)"

# Retention runs only after a good backup, so a run of failures never deletes
# the last known-good copy.
if [[ "$RETENTION_DAYS" -gt 0 ]]; then
  deleted="$(find "$BACKUP_DIR" -name 'riai-*.dump' -type f -mtime "+${RETENTION_DAYS}" -print -delete | wc -l | tr -d ' ')"
  [[ "$deleted" -gt 0 ]] && echo "backup: removed ${deleted} older than ${RETENTION_DAYS} days"
fi

exit 0
