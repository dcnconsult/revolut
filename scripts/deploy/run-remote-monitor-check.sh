#!/usr/bin/env bash
set -Eeuo pipefail

app_root="/opt/revolut"
env_file="/etc/revolut/revolut.env"
backup_directory="/var/backups/revolut"
maximum_backup_age_seconds="${MAXIMUM_BACKUP_AGE_SECONDS:-691200}"
maximum_disk_percent="${MAXIMUM_DISK_PERCENT:-85}"
monitor_step="initialization"

trap 'echo "REMOTE_MONITOR_FAILED step=${monitor_step}" >&2' ERR

for command_name in curl docker jq sha256sum stat systemctl; do
  command -v "${command_name}" >/dev/null
done

current_release="$(readlink -f "${app_root}/current")"
release_sha="$(basename "${current_release}")"
[[ -d "${current_release}" && "${release_sha}" =~ ^[0-9a-f]{40}$ ]]

revolut_mode="$(sed -n 's/^REVOLUT_MODE=//p' "${env_file}" | tail -n 1)"
[[ "${revolut_mode}" == "sandbox" ]]

monitor_step="service-health"
health_response="$(curl --fail --silent --show-error --max-time 15 \
  http://127.0.0.1:3000/health)"
jq -e '.status == "ok" and .mode == "sandbox"' \
  <<<"${health_response}" >/dev/null
for _attempt in {1..30}; do
  if [[ "$(docker inspect --format '{{.State.Health.Status}}' revolut-api-1)" == "healthy" ]]; then
    break
  fi
  sleep 1
done
[[ "$(docker inspect --format '{{.State.Health.Status}}' revolut-api-1)" == "healthy" ]]
[[ "$(docker port revolut-api-1 3000/tcp)" == "127.0.0.1:3000" ]]

monitor_step="sandbox-authentication"
phase2_output="$(bash "${current_release}/scripts/deploy/run-sandbox-phase2-check.sh")"
[[ "${phase2_output}" == PHASE2_SANDBOX_OK* ]]

monitor_step="database-monitoring"
automation_token="$(< /etc/revolut/sandbox/automation-token)"
accounts_response="$(curl --fail --silent --show-error --max-time 30 \
  --header "authorization: Bearer ${automation_token}" \
  http://127.0.0.1:3000/v1/sandbox/accounts)"
summary_response="$(curl --fail --silent --show-error --max-time 15 \
  --header "authorization: Bearer ${automation_token}" \
  http://127.0.0.1:3000/v1/sandbox/monitoring/summary)"
audit_response="$(curl --fail --silent --show-error --max-time 15 \
  --header "authorization: Bearer ${automation_token}" \
  'http://127.0.0.1:3000/v1/sandbox/monitoring/audit-events?limit=1')"
error_report_response="$(curl --fail --silent --show-error --max-time 15 \
  --header "authorization: Bearer ${automation_token}" \
  http://127.0.0.1:3000/v1/sandbox/monitoring/error-report)"
jq -e 'type == "array"' <<<"${accounts_response}" >/dev/null
jq -e '.total | type == "number" and . >= 0' \
  <<<"${summary_response}" >/dev/null
jq -e 'type == "array"' <<<"${audit_response}" >/dev/null
jq -e '.health != "blocked" and (.unresolved | type == "number")' \
  <<<"${error_report_response}" >/dev/null
operations_health="$(jq -r '.health' <<<"${error_report_response}")"
docker volume inspect revolut_revolut-data >/dev/null

monitor_step="backup-freshness"
[[ -d "${backup_directory}" ]]
latest_checksum="$(find "${backup_directory}" -maxdepth 1 -type f -name '*.sha256' \
  -printf '%T@ %f\n' | sort -nr | head -n 1 | cut -d' ' -f2-)"
[[ -n "${latest_checksum}" ]]
(
  cd "${backup_directory}"
  sha256sum --check --status "${latest_checksum}"
)
backup_file="${backup_directory}/${latest_checksum%.sha256}"
backup_age_seconds="$(( $(date +%s) - $(stat -c '%Y' "${backup_file}") ))"
(( backup_age_seconds >= 0 && backup_age_seconds <= maximum_backup_age_seconds ))

monitor_step="backup-schedule"
systemctl is-active --quiet cron
grep -Fqx \
  '17 3 * * 0 deploy /opt/revolut/current/scripts/deploy/backup-sandbox-database.sh --storage local --retention 4 >> /var/backups/revolut/cron.log 2>&1' \
  /etc/cron.d/revolut-sqlite-backup

monitor_step="credential-permissions"
for credential_file in \
  /etc/revolut/sandbox/config.json \
  /etc/revolut/sandbox/tokens.json \
  /etc/revolut/sandbox/privatecert.pem \
  /etc/revolut/sandbox/operator-auth.json \
  /etc/revolut/sandbox/automation-token; do
  credential_mode="$(stat -c '%a' "${credential_file}")"
  [[ "${credential_mode}" =~ ^(400|440|600|640)$ ]]
done

monitor_step="disk-capacity"
disk_percent="$(df --output=pcent "${app_root}" | tail -n 1 | tr -dc '0-9')"
[[ "${disk_percent}" =~ ^[0-9]+$ ]]
(( disk_percent < maximum_disk_percent ))

trap - ERR
echo "REMOTE_MONITOR_OK mode=sandbox health=ok authentication=ok database=ok operations=${operations_health} backup=fresh cron=active disk=ok bind=loopback"
