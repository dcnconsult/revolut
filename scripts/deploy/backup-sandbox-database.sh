#!/usr/bin/env bash
set -Eeuo pipefail

app_root="/opt/revolut"
current_release="$(readlink -f "${app_root}/current")"
if [[ -z "${current_release}" || ! -d "${current_release}" ]]; then
  echo "SQLITE_BACKUP_FAILED: no active release." >&2
  exit 1
fi

image_tag="$(basename "${current_release}")"
docker run --rm \
  --user node \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --mount type=volume,source=revolut_revolut-data,target=/var/lib/revolut,readonly \
  --mount type=bind,source=/var/backups/revolut,target=/backups \
  --env SANDBOX_DATABASE_PATH=/var/lib/revolut/sandbox-transfers.sqlite \
  --env SANDBOX_BACKUP_DIRECTORY=/backups \
  "revolut-api:${image_tag}" \
  node scripts/backup-sqlite.mjs
