#!/usr/bin/env bash
#
# Restore a backup into a database.
#
# The guard is the point. `pg_restore --clean` drops and recreates every object
# it touches, so pointing this at the wrong URL destroys a live ledger — and the
# wrong URL is one shell-history entry away from the right one. The target must
# therefore either look like a restore target by name, or be confirmed with
# RESTORE_I_MEAN_IT=yes.
set -Eeuo pipefail

# Prisma's DATABASE_URL carries `?schema=`, which libpq does not understand and
# rejects outright — "invalid URI query parameter". Every URL in this project
# has it, so stripping that one parameter is the difference between these
# scripts working for everybody and working for nobody. Anything else in the
# query string (sslmode and friends) is libpq's own and is kept.
libpq_url() {
  printf '%s' "$1" | sed -E 's/([?&])schema=[^&]*&?/\1/; s/[?&]$//'
}

dump="${1:-}"
target="${2:-${RESTORE_DATABASE_URL:-}}"

if [[ -z "$dump" || -z "$target" ]]; then
  echo "usage: restore.sh <dump-file> <target-database-url>" >&2
  exit 2
fi

if [[ ! -r "$dump" ]]; then
  echo "restore: cannot read ${dump}" >&2
  exit 2
fi

if ! command -v pg_restore >/dev/null 2>&1; then
  echo "restore: pg_restore not found. Install the postgresql-client package." >&2
  exit 2
fi

# The database name, without credentials or query string.
name="$(printf '%s' "$target" | sed -E 's#^.*/([^/?]+)(\?.*)?$#\1#')"

if [[ ! "$name" =~ (_test|_restore|_staging|_scratch)$ ]]; then
  if [[ "${RESTORE_I_MEAN_IT:-}" != "yes" ]]; then
    cat >&2 <<MSG
restore: "${name}" is not obviously a restore target.

This drops and recreates every object in it. If that is genuinely what you
want, re-run with RESTORE_I_MEAN_IT=yes. Practise on a database whose name
ends in _restore first — a restore nobody has rehearsed is a guess.
MSG
    exit 3
  fi
fi

pg_restore --clean --if-exists --no-owner --no-acl \
  --dbname="$(libpq_url "$target")" "$dump"
echo "restore: ${dump} restored into ${name}"
