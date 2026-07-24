#!/usr/bin/env bash
set -Eeuo pipefail

config_file="/etc/revolut/offsite-backup.env"
backup_directory="/var/backups/revolut"
retention="4"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --retention)
      retention="${2:-}"
      shift 2
      ;;
    --help)
      echo "Usage: upload-offsite-backup.sh [--retention COUNT]"
      exit 0
      ;;
    *)
      echo "OFFSITE_BACKUP_FAILED: unsupported argument: $1" >&2
      exit 2
      ;;
  esac
done

if [[ ! "${retention}" =~ ^[1-9][0-9]*$ ]] || (( retention > 52 )); then
  echo "OFFSITE_BACKUP_FAILED: --retention must be an integer from 1 to 52." >&2
  exit 2
fi

if [[ ! -r "${config_file}" ]]; then
  echo "OFFSITE_BACKUP_DISABLED: configuration is not installed." >&2
  exit 2
fi

read_setting() {
  local setting_name="$1"
  sed -n "s/^${setting_name}=//p" "${config_file}" | tail -n 1
}

enabled="$(read_setting OFFSITE_BACKUP_ENABLED)"
destination="$(read_setting OFFSITE_RCLONE_DESTINATION)"
age_recipient="$(read_setting OFFSITE_AGE_RECIPIENT)"
rclone_config="$(read_setting OFFSITE_RCLONE_CONFIG)"
rclone_config="${rclone_config:-/etc/revolut/rclone.conf}"

if [[ "${enabled}" != "YES" ]]; then
  echo "OFFSITE_BACKUP_DISABLED: set OFFSITE_BACKUP_ENABLED=YES after storage is configured." >&2
  exit 2
fi
if [[ ! "${destination}" =~ ^[A-Za-z0-9._-]+:.+ ]] || [[ "${destination}" =~ [[:space:]] ]]; then
  echo "OFFSITE_BACKUP_FAILED: invalid rclone destination." >&2
  exit 1
fi
if [[ ! "${age_recipient}" =~ ^age1[0-9a-z]+$ ]]; then
  echo "OFFSITE_BACKUP_FAILED: invalid age recipient." >&2
  exit 1
fi
if [[ ! -r "${rclone_config}" ]]; then
  echo "OFFSITE_BACKUP_FAILED: rclone configuration is missing or unreadable." >&2
  exit 1
fi

for command_name in age jq rclone sha256sum; do
  command -v "${command_name}" >/dev/null
done

latest_checksum="$(find "${backup_directory}" -maxdepth 1 -type f -name '*.sha256' \
  -printf '%T@ %f\n' | sort -nr | head -n 1 | cut -d' ' -f2-)"
[[ -n "${latest_checksum}" ]]
(
  cd "${backup_directory}"
  sha256sum --check --status "${latest_checksum}"
)

source_file="${backup_directory}/${latest_checksum%.sha256}"
source_name="$(basename "${source_file}")"
encrypted_file="$(mktemp --tmpdir="${backup_directory}" '.offsite-encrypted.XXXXXXXX')"
encrypted_checksum="${encrypted_file}.sha256"
trap 'rm -f -- "${encrypted_file}" "${encrypted_checksum}"' EXIT

age --encrypt --recipient "${age_recipient}" \
  --output "${encrypted_file}" "${source_file}"
chmod 0600 "${encrypted_file}"
encrypted_name="${source_name}.age"
encrypted_digest="$(sha256sum "${encrypted_file}" | cut -d' ' -f1)"
printf '%s  %s\n' "${encrypted_digest}" "${encrypted_name}" >"${encrypted_checksum}"
chmod 0600 "${encrypted_checksum}"

remote_base="${destination%/}/${encrypted_name}"
rclone --config "${rclone_config}" copyto "${encrypted_file}" "${remote_base}"
rclone --config "${rclone_config}" copyto "${encrypted_checksum}" "${remote_base}.sha256"

objects_json="$(rclone --config "${rclone_config}" lsjson "${destination%/}" \
  --files-only --include 'sandbox-transfers-*.sqlite.age')"
mapfile -t expired_objects < <(
  jq -r --argjson retention "${retention}" \
    'sort_by(.ModTime) | reverse | .[$retention:][]?.Path' \
    <<<"${objects_json}"
)
removed_count=0
for object_path in "${expired_objects[@]}"; do
  if [[ "${object_path}" =~ ^sandbox-transfers-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z\.sqlite\.age$ ]]; then
    rclone --config "${rclone_config}" deletefile \
      "${destination%/}/${object_path}.sha256"
    rclone --config "${rclone_config}" deletefile \
      "${destination%/}/${object_path}"
    (( removed_count += 1 ))
  fi
done

echo "OFFSITE_BACKUP_OK file=${encrypted_name} encryption=age checksum=sha256 retained=${retention} removed=${removed_count}"
