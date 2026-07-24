#!/usr/bin/env bash
set -Eeuo pipefail

release_sha="${1:-}"
app_root="/opt/revolut"
release_dir="${app_root}/releases/${release_sha}"
env_file="/etc/revolut/revolut.env"

if [[ ! "${release_sha}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Expected a full 40-character Git commit SHA." >&2
  exit 1
fi

if [[ ! -d "${release_dir}" || ! -f "${release_dir}/compose.yaml" ]]; then
  echo "Release directory is incomplete: ${release_dir}" >&2
  exit 1
fi

if [[ ! -r "${env_file}" ]]; then
  echo "Environment file is missing or unreadable: ${env_file}" >&2
  exit 1
fi

if ! grep -qx 'REVOLUT_MODE=mock' "${env_file}"; then
  echo "Refusing deployment: REVOLUT_MODE must be exactly mock." >&2
  exit 1
fi

previous_release=""
if [[ -L "${app_root}/current" ]]; then
  previous_release="$(readlink -f "${app_root}/current")"
fi

cd "${release_dir}"
export IMAGE_TAG="${release_sha}"
export REVOLUT_ENV_FILE="${env_file}"

docker compose build --pull
docker compose up -d --remove-orphans --wait --wait-timeout 90

health_response="$(curl --fail --silent --show-error \
  --retry 8 \
  --retry-delay 2 \
  --retry-all-errors \
  http://127.0.0.1:3000/health)"

if [[ "${health_response}" != *'"mode":"mock"'* ]]; then
  echo "Health response did not confirm mock mode: ${health_response}" >&2
  if [[ -n "${previous_release}" && -d "${previous_release}" ]]; then
    previous_sha="$(basename "${previous_release}")"
    cd "${previous_release}"
    IMAGE_TAG="${previous_sha}" REVOLUT_ENV_FILE="${env_file}" \
      docker compose up -d --remove-orphans --wait --wait-timeout 90
  fi
  exit 1
fi

ln -sfn "${release_dir}" "${app_root}/current"
docker image prune -f

echo "Activated ${release_sha}: ${health_response}"
