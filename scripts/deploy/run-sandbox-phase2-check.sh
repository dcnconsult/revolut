#!/usr/bin/env bash
set -Eeuo pipefail

app_root="/opt/revolut"
config_file="/etc/revolut/sandbox/config.json"
tokens_file="/etc/revolut/sandbox/tokens.json"
private_key_file="/etc/revolut/sandbox/privatecert.pem"
current_release="$(readlink -f "${app_root}/current")"

if [[ -z "${current_release}" || ! -d "${current_release}" ]]; then
  echo "PHASE2_SANDBOX_FAILED: no active application release was found." >&2
  exit 1
fi

if [[ ! -r "${config_file}" ]]; then
  echo "PHASE2_SANDBOX_FAILED: ${config_file} is missing or unreadable." >&2
  exit 1
fi

if [[ ! -r "${tokens_file}" ]]; then
  echo "PHASE2_SANDBOX_FAILED: ${tokens_file} is missing or unreadable." >&2
  exit 1
fi

if [[ ! -r "${private_key_file}" ]]; then
  echo "PHASE2_SANDBOX_FAILED: ${private_key_file} is missing or unreadable." >&2
  exit 1
fi

cd "${current_release}"
export IMAGE_TAG="$(basename "${current_release}")"
export REVOLUT_SANDBOX_CONFIG_FILE="${config_file}"
export REVOLUT_SANDBOX_TOKENS_FILE="${tokens_file}"
export REVOLUT_SANDBOX_PRIVATE_KEY_FILE="${private_key_file}"

docker compose --profile sandbox-phase2 run --rm --no-deps sandbox-probe
