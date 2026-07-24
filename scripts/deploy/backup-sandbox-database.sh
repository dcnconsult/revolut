#!/usr/bin/env bash
set -Eeuo pipefail

app_root="/opt/revolut"
backup_directory="/var/backups/revolut"
storage="local"
retention="4"

usage() {
  cat <<'EOF'
Usage: backup-sandbox-database.sh [--storage local|object] [--retention COUNT]

Creates a verified SQLite backup, retains the newest COUNT local backup pairs,
and optionally uploads an age-encrypted copy to configured object storage.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --storage)
      storage="${2:-}"
      shift 2
      ;;
    --retention)
      retention="${2:-}"
      shift 2
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      echo "SQLITE_BACKUP_FAILED: unsupported argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "${storage}" != "local" && "${storage}" != "object" ]]; then
  echo "SQLITE_BACKUP_FAILED: --storage must be local or object." >&2
  exit 2
fi
if [[ ! "${retention}" =~ ^[1-9][0-9]*$ ]] || (( retention > 52 )); then
  echo "SQLITE_BACKUP_FAILED: --retention must be an integer from 1 to 52." >&2
  exit 2
fi

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
  --mount type=bind,source="${backup_directory}",target=/backups \
  --env SANDBOX_DATABASE_PATH=/var/lib/revolut/sandbox-transfers.sqlite \
  --env SANDBOX_BACKUP_DIRECTORY=/backups \
  "revolut-api:${image_tag}" \
  node scripts/backup-sqlite.mjs

mapfile -t backup_files < <(
  find "${backup_directory}" -maxdepth 1 -type f \
    -name 'sandbox-transfers-*.sqlite' -printf '%T@ %f\n' |
    sort -nr |
    cut -d' ' -f2-
)
removed_count=0
for (( index=retention; index<${#backup_files[@]}; index++ )); do
  backup_name="${backup_files[index]}"
  if [[ "${backup_name}" =~ ^sandbox-transfers-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z\.sqlite$ ]]; then
    rm -f -- \
      "${backup_directory}/${backup_name}" \
      "${backup_directory}/${backup_name}.sha256"
    (( removed_count += 1 ))
  fi
done

if [[ "${storage}" == "object" ]]; then
  bash "${current_release}/scripts/deploy/upload-offsite-backup.sh" \
    --retention "${retention}"
fi

echo "SQLITE_BACKUP_RETENTION_OK storage=${storage} retained=${retention} removed=${removed_count}"
