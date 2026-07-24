#!/usr/bin/env bash
set -Eeuo pipefail

config_file="/etc/revolut/offsite-backup.env"
backup_directory="/var/backups/revolut"

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

for command_name in age rclone sha256sum; do
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

echo "OFFSITE_BACKUP_OK file=${encrypted_name} encryption=age checksum=sha256"
