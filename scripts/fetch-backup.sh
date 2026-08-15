#!/usr/bin/env bash
#
# Bring a backup back from the object store.
#
# The half of "offsite backups" that people skip. A dump nobody has ever
# retrieved is a dump nobody knows is retrievable — the credentials may be
# wrong, the bucket may be in another account, the objects may be in a storage
# class that takes hours to restore. All of that is discoverable in a quiet
# minute now, or during an incident, and it is the same amount of work either
# time.
#
#   scripts/fetch-backup.sh                  # newest, into ./backups
#   scripts/fetch-backup.sh --list           # what is there
#   scripts/fetch-backup.sh --key riai/riai-20260815T031500Z.dump
#
# Then rehearse the rest:
#   RESTORE_I_MEAN_IT=yes scripts/restore.sh backups/riai-....dump riai_restore
set -Eeuo pipefail

BACKUP_DIR="${BACKUP_DIR:-./backups}"
S3_BUCKET="${BACKUP_S3_BUCKET:-}"
S3_PREFIX="${BACKUP_S3_PREFIX:-riai}"
S3_ENDPOINT="${BACKUP_S3_ENDPOINT:-}"

want_list=0
want_key=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --list) want_list=1; shift ;;
    --key) want_key="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "fetch-backup: unknown argument $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$S3_BUCKET" ]]; then
  echo "fetch-backup: BACKUP_S3_BUCKET is not set — there is no off-machine copy to fetch" >&2
  exit 2
fi
if ! command -v aws >/dev/null 2>&1; then
  echo "fetch-backup: the aws CLI is not installed" >&2
  exit 2
fi

aws_args=()
[[ -n "$S3_ENDPOINT" ]] && aws_args+=(--endpoint-url "$S3_ENDPOINT")

# Sorted by key, and the key carries a sortable UTC stamp — so the last line is
# the newest. Sorting by LastModified would be subtly wrong: re-uploading an old
# dump would make it look like the newest backup.
keys="$(aws "${aws_args[@]}" s3api list-objects-v2 \
  --bucket "$S3_BUCKET" --prefix "${S3_PREFIX%/}/riai-" \
  --query 'Contents[].Key' --output text 2>/dev/null | tr '\t' '\n' | sort || true)"

if [[ -z "$keys" || "$keys" == "None" ]]; then
  echo "fetch-backup: no backups found under s3://${S3_BUCKET}/${S3_PREFIX%/}/" >&2
  exit 1
fi

if [[ "$want_list" -eq 1 ]]; then
  echo "$keys"
  exit 0
fi

key="${want_key:-$(printf '%s\n' "$keys" | tail -n 1)}"

mkdir -p "$BACKUP_DIR"
target="${BACKUP_DIR}/$(basename "$key")"

echo "fetch-backup: downloading ${key}"
aws "${aws_args[@]}" s3 cp "s3://${S3_BUCKET}/${key}" "$target" --only-show-errors

# Verified the same way a fresh dump is, and for the same reason: a file that
# arrived truncated looks exactly like a backup until the day it is needed.
if ! command -v pg_restore >/dev/null 2>&1; then
  echo "fetch-backup: wrote ${target} (pg_restore not installed, so it was not verified)" >&2
  exit 0
fi

tables="$(pg_restore --list "$target" 2>/dev/null | grep -c 'TABLE DATA' || true)"
if [[ "${tables:-0}" -lt 1 ]]; then
  echo "fetch-backup: downloaded file contains no table data — it is not a usable backup" >&2
  exit 1
fi

bytes="$(wc -c <"$target" | tr -d ' ')"
echo "fetch-backup: wrote ${target} (${bytes} bytes, ${tables} tables, verified)"
