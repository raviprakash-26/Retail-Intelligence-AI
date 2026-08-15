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

# Off-machine copy. Unset means local only, which is the default and is stated
# plainly rather than implied: a dump sitting beside the database it came from
# survives a dropped table and not a dead disk.
#
# Any S3-compatible store works — S3, R2, Supabase, MinIO — because the only
# thing that differs between them is the endpoint. The AWS CLI does the signing
# and the multipart upload; hand-rolling SigV4 in a backup script would put a
# correctness risk exactly where nobody would notice it until a restore.
S3_BUCKET="${BACKUP_S3_BUCKET:-}"
S3_PREFIX="${BACKUP_S3_PREFIX:-riai}"
S3_ENDPOINT="${BACKUP_S3_ENDPOINT:-}"
S3_STORAGE_CLASS="${BACKUP_S3_STORAGE_CLASS:-}"
S3_SSE="${BACKUP_S3_SSE:-}"

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

# --------------------------------------------------------------------------
# Off the machine
# --------------------------------------------------------------------------
# Runs before local retention, deliberately. If the copy cannot be sent
# somewhere else, the local copies that already exist are the only ones there
# are, and deleting the oldest of them because a clock ticked would be the
# wrong response to a failure.
if [[ -n "$S3_BUCKET" ]]; then
  if ! command -v aws >/dev/null 2>&1; then
    echo "backup: BACKUP_S3_BUCKET is set but the aws CLI is not installed" >&2
    exit 2
  fi

  key="${S3_PREFIX%/}/$(basename "$target")"
  s3_uri="s3://${S3_BUCKET}/${key}"

  # Endpoint and storage class are optional and provider-specific. Built as an
  # array so an unset value contributes no argument at all rather than an empty
  # string the CLI would reject.
  aws_args=()
  [[ -n "$S3_ENDPOINT" ]] && aws_args+=(--endpoint-url "$S3_ENDPOINT")

  copy_args=()
  [[ -n "$S3_STORAGE_CLASS" ]] && copy_args+=(--storage-class "$S3_STORAGE_CLASS")
  [[ -n "$S3_SSE" ]] && copy_args+=(--sse "$S3_SSE")

  echo "backup: uploading to ${s3_uri}"
  if ! aws "${aws_args[@]}" s3 cp "$target" "$s3_uri" "${copy_args[@]}" --only-show-errors; then
    echo "backup: upload failed — the local copy is kept and nothing was pruned" >&2
    exit 1
  fi

  # Verify the object that landed, for the same reason the dump is read back
  # before it is kept: an upload that truncated is the ordinary way an offsite
  # backup turns out to be worthless, and it costs one request to find out.
  remote_bytes="$(aws "${aws_args[@]}" s3api head-object \
    --bucket "$S3_BUCKET" --key "$key" \
    --query 'ContentLength' --output text 2>/dev/null || true)"

  if [[ "${remote_bytes:-}" != "$bytes" ]]; then
    echo "backup: uploaded object is ${remote_bytes:-missing} bytes, expected ${bytes}" >&2
    echo "backup: treating the offsite copy as failed — nothing was pruned" >&2
    exit 1
  fi
  echo "backup: uploaded ${key} (${remote_bytes} bytes, verified)"

  # Remote retention, after a verified upload and never before. Objects are
  # named with a sortable UTC stamp, so "older than" is a string comparison
  # against a cutoff rather than a per-object metadata read.
  if [[ "$RETENTION_DAYS" -gt 0 ]]; then
    cutoff="$(date -u -d "${RETENTION_DAYS} days ago" +%Y%m%dT%H%M%SZ 2>/dev/null \
      || date -u -v"-${RETENTION_DAYS}d" +%Y%m%dT%H%M%SZ)"
    pruned=0
    while read -r old_key; do
      [[ -z "$old_key" ]] && continue
      stamp_part="${old_key##*/riai-}"
      stamp_part="${stamp_part%.dump}"
      # Anything that is not one of ours, or has no readable stamp, is left
      # alone. A retention job that deletes files it does not recognise is a
      # retention job that eventually deletes something it should not.
      [[ "$stamp_part" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || continue
      if [[ "$stamp_part" < "$cutoff" ]]; then
        aws "${aws_args[@]}" s3 rm "s3://${S3_BUCKET}/${old_key}" --only-show-errors && pruned=$((pruned + 1))
      fi
    done < <(aws "${aws_args[@]}" s3api list-objects-v2 \
      --bucket "$S3_BUCKET" --prefix "${S3_PREFIX%/}/riai-" \
      --query 'Contents[].Key' --output text 2>/dev/null | tr '\t' '\n')

    [[ "$pruned" -gt 0 ]] && echo "backup: removed ${pruned} remote copies older than ${RETENTION_DAYS} days"
  fi
else
  echo "backup: no BACKUP_S3_BUCKET set — this copy is on the same machine as the database"
fi

# Retention runs only after a good backup, so a run of failures never deletes
# the last known-good copy.
if [[ "$RETENTION_DAYS" -gt 0 ]]; then
  deleted="$(find "$BACKUP_DIR" -name 'riai-*.dump' -type f -mtime "+${RETENTION_DAYS}" -print -delete | wc -l | tr -d ' ')"
  [[ "$deleted" -gt 0 ]] && echo "backup: removed ${deleted} older than ${RETENTION_DAYS} days"
fi

exit 0
