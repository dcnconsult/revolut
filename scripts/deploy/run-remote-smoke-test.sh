#!/usr/bin/env bash
set -Eeuo pipefail

app_root="/opt/revolut"
env_file="/etc/revolut/revolut.env"
expected_sha="${1:-}"
smoke_step="initialization"

trap 'echo "REMOTE_SMOKE_FAILED step=${smoke_step}" >&2' ERR

current_release="$(readlink -f "${app_root}/current")"
if [[ -z "${current_release}" || ! -d "${current_release}" ]]; then
  echo "REMOTE_SMOKE_FAILED: no active release was found." >&2
  exit 1
fi

if [[ -z "${expected_sha}" ]]; then
  expected_sha="$(basename "${current_release}")"
fi
if [[ ! "${expected_sha}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "REMOTE_SMOKE_FAILED: expected a full 40-character Git commit SHA." >&2
  exit 2
fi
if [[ "${current_release}" != "${app_root}/releases/${expected_sha}" ]]; then
  echo "REMOTE_SMOKE_FAILED: active release does not match the expected commit." >&2
  exit 1
fi

revolut_mode="$(sed -n 's/^REVOLUT_MODE=//p' "${env_file}" | tail -n 1)"
if [[ "${revolut_mode}" != "sandbox" ]]; then
  echo "REMOTE_SMOKE_FAILED: this test runs only in Revolut Sandbox mode." >&2
  exit 1
fi

smoke_step="loopback-bind"
published_port="$(docker port revolut-api-1 3000/tcp)"
[[ "${published_port}" == "127.0.0.1:3000" ]]

smoke_step="health"
health_response="$(curl --fail --silent --show-error --max-time 15 \
  http://127.0.0.1:3000/health)"
jq -e '.status == "ok" and .mode == "sandbox"' \
  <<<"${health_response}" >/dev/null

smoke_step="sandbox-accounts"
automation_token="$(< /etc/revolut/sandbox/automation-token)"
accounts_response="$(curl --fail --silent --show-error --max-time 30 \
  --header "authorization: Bearer ${automation_token}" \
  http://127.0.0.1:3000/v1/sandbox/accounts)"
account_pair="$(jq -c 'first(
  .[] as $source
  | .[] as $target
  | select(
      $source.id != $target.id
      and $source.currency == $target.currency
      and $source.state == "active"
      and $target.state == "active"
      and $source.balanceMinor >= 1
    )
  | {source: $source.id, target: $target.id, currency: $source.currency}
)' <<<"${accounts_response}")"
[[ -n "${account_pair}" && "${account_pair}" != "null" ]]

smoke_step="prepared-only-transfer"
client_reference="smoke-${expected_sha:0:12}-$(date -u +%s)"
request_body="$(jq -cn \
  --argjson pair "${account_pair}" \
  --arg client_reference "${client_reference}" \
  '{
    sourceAccountId: $pair.source,
    targetAccountId: $pair.target,
    amountMinor: 1,
    currency: $pair.currency,
    reference: "AUTOMATED SANDBOX SMOKE TEST - PREPARE ONLY",
    clientReference: $client_reference
  }')"
first_prepare="$(curl --fail --silent --show-error --max-time 30 \
  --header "authorization: Bearer ${automation_token}" \
  --header 'content-type: application/json' \
  --data "${request_body}" \
  http://127.0.0.1:3000/v1/sandbox/internal-transfers/prepare)"
second_prepare="$(curl --fail --silent --show-error --max-time 30 \
  --header "authorization: Bearer ${automation_token}" \
  --header 'content-type: application/json' \
  --data "${request_body}" \
  http://127.0.0.1:3000/v1/sandbox/internal-transfers/prepare)"
record_id="$(jq -r '.id' <<<"${first_prepare}")"
[[ "${record_id}" =~ ^[0-9a-f-]{36}$ ]]
jq -e --arg record_id "${record_id}" \
  '.id == $record_id and .state == "prepared" and (.providerTransactionId == null)' \
  <<<"${first_prepare}" >/dev/null
jq -e --arg record_id "${record_id}" \
  '.id == $record_id and .state == "prepared" and (.providerTransactionId == null)' \
  <<<"${second_prepare}" >/dev/null

smoke_step="restart-persistence"
docker restart revolut-api-1 >/dev/null
for _attempt in {1..30}; do
  if curl --fail --silent --max-time 5 \
    http://127.0.0.1:3000/health >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
persisted_record="$(curl --fail --silent --show-error --max-time 15 \
  --header "authorization: Bearer ${automation_token}" \
  "http://127.0.0.1:3000/v1/sandbox/internal-transfers/${record_id}")"
jq -e --arg record_id "${record_id}" \
  '.id == $record_id and .state == "prepared" and (.providerTransactionId == null)' \
  <<<"${persisted_record}" >/dev/null

smoke_step="monitoring"
transfers_response="$(curl --fail --silent --show-error --max-time 15 \
  --header "authorization: Bearer ${automation_token}" \
  'http://127.0.0.1:3000/v1/sandbox/monitoring/transfers?limit=500')"
audit_response="$(curl --fail --silent --show-error --max-time 15 \
  --header "authorization: Bearer ${automation_token}" \
  'http://127.0.0.1:3000/v1/sandbox/monitoring/audit-events?limit=500')"
error_report_response="$(curl --fail --silent --show-error --max-time 15 \
  --header "authorization: Bearer ${automation_token}" \
  http://127.0.0.1:3000/v1/sandbox/monitoring/error-report)"
errors_response="$(curl --fail --silent --show-error --max-time 15 \
  --header "authorization: Bearer ${automation_token}" \
  'http://127.0.0.1:3000/v1/sandbox/monitoring/errors?limit=25')"
jq -e --arg record_id "${record_id}" \
  'any(.[]; .id == $record_id and .state == "prepared")' \
  <<<"${transfers_response}" >/dev/null
jq -e --arg record_id "${record_id}" \
  'any(.[]; .transferId == $record_id and .eventType == "prepared" and .state == "prepared")' \
  <<<"${audit_response}" >/dev/null
jq -e '.health != "blocked" and .critical == 0' \
  <<<"${error_report_response}" >/dev/null
jq -e 'type == "array"' <<<"${errors_response}" >/dev/null
operations_health="$(jq -r '.health' <<<"${error_report_response}")"

smoke_step="automation-submit-denied"
submit_status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 15 \
  --header "authorization: Bearer ${automation_token}" \
  --header 'content-type: application/json' \
  --data '{}' \
  "http://127.0.0.1:3000/v1/sandbox/internal-transfers/${record_id}/submit")"
[[ "${submit_status}" == "403" ]]

smoke_step="text-console"
docker exec revolut-api-1 test -r scripts/operator/console-core.mjs
set +e
text_console_output="$(docker exec revolut-api-1 \
  node scripts/operator/console.mjs 2>&1)"
text_console_status=$?
set -e
[[ "${text_console_status}" == "2" ]]
[[ "${text_console_output}" == *"requires an interactive terminal"* ]]

smoke_step="backup"
bash "${current_release}/scripts/deploy/backup-sandbox-database.sh" >/dev/null
latest_checksum="$(find /var/backups/revolut -maxdepth 1 -type f -name '*.sha256' \
  -printf '%T@ %f\n' | sort -nr | head -n 1 | cut -d' ' -f2-)"
[[ -n "${latest_checksum}" ]]
(
  cd /var/backups/revolut
  sha256sum --check --status "${latest_checksum}"
)

trap - ERR
echo "REMOTE_SMOKE_OK mode=sandbox transfer=prepared-only idempotency=ok persistence=ok monitoring=ok operations=${operations_health} text_console=ok backup=ok bind=loopback"
