#!/usr/bin/env bash
set -Eeuo pipefail

app_root="/opt/revolut"
config_file="/etc/revolut/sandbox/config.json"
tokens_file="/etc/revolut/sandbox/tokens.json"
private_key_file="/etc/revolut/sandbox/privatecert.pem"
amount="0.01"
execute="NO"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --amount)
      amount="${2:-}"
      shift 2
      ;;
    --execute)
      execute="YES"
      shift
      ;;
    *)
      echo "PHASE3_SANDBOX_TRANSFER_FAILED: unsupported argument: $1" >&2
      exit 2
      ;;
  esac
done

if [[ ! "${amount}" =~ ^([0-9]+)(\.[0-9]{1,2})?$ ]]; then
  echo "PHASE3_SANDBOX_TRANSFER_FAILED: amount must be a positive number with at most two decimals." >&2
  exit 2
fi

current_release="$(readlink -f "${app_root}/current")"
if [[ -z "${current_release}" || ! -d "${current_release}" ]]; then
  echo "PHASE3_SANDBOX_TRANSFER_FAILED: no active application release was found." >&2
  exit 1
fi

for required_file in "${config_file}" "${tokens_file}" "${private_key_file}"; do
  if [[ ! -r "${required_file}" ]]; then
    echo "PHASE3_SANDBOX_TRANSFER_FAILED: ${required_file} is missing or unreadable." >&2
    exit 1
  fi
done

cd "${current_release}"
export IMAGE_TAG="$(basename "${current_release}")"
export REVOLUT_SANDBOX_CONFIG_FILE="${config_file}"
export REVOLUT_SANDBOX_TOKENS_FILE="${tokens_file}"
export REVOLUT_SANDBOX_PRIVATE_KEY_FILE="${private_key_file}"
export SANDBOX_TRANSFER_AMOUNT="${amount}"
export SANDBOX_TRANSFER_EXECUTE="${execute}"

docker compose --profile sandbox-phase3 run --rm --no-deps sandbox-transfer-probe
