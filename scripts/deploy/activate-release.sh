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

revolut_mode="$(sed -n 's/^REVOLUT_MODE=//p' "${env_file}" | tail -n 1)"
if [[ "${revolut_mode}" != "mock" && "${revolut_mode}" != "sandbox" ]]; then
  echo "Refusing deployment: REVOLUT_MODE must be exactly mock or sandbox." >&2
  exit 1
fi

compose_args=(-f compose.yaml)
if [[ "${revolut_mode}" == "sandbox" ]]; then
  sandbox_overlay="${release_dir}/compose.sandbox.yaml"
  if [[ ! -f "${sandbox_overlay}" ]]; then
    echo "Sandbox deployment overlay is missing: ${sandbox_overlay}" >&2
    exit 1
  fi
  for credential_file in \
    /etc/revolut/sandbox/config.json \
    /etc/revolut/sandbox/tokens.json \
    /etc/revolut/sandbox/privatecert.pem \
    /etc/revolut/sandbox/operator-auth.json \
    /etc/revolut/sandbox/automation-token; do
    if [[ ! -r "${credential_file}" ]]; then
      echo "Sandbox credential is missing or unreadable: ${credential_file}" >&2
      exit 1
    fi
  done
  export REVOLUT_SANDBOX_CONFIG_FILE="/etc/revolut/sandbox/config.json"
  export REVOLUT_SANDBOX_TOKENS_FILE="/etc/revolut/sandbox/tokens.json"
  export REVOLUT_SANDBOX_PRIVATE_KEY_FILE="/etc/revolut/sandbox/privatecert.pem"
  export OPERATOR_AUTH_CONFIG_FILE="/etc/revolut/sandbox/operator-auth.json"
  compose_args+=(-f compose.sandbox.yaml)
fi

previous_release=""
if [[ -L "${app_root}/current" ]]; then
  previous_release="$(readlink -f "${app_root}/current")"
fi

rollback_previous_release() {
  if [[ -z "${previous_release}" || ! -d "${previous_release}" ]]; then
    echo "ROLLBACK_UNAVAILABLE: no previous release exists." >&2
    return 1
  fi

  previous_sha="$(basename "${previous_release}")"
  rollback_compose_args=(-f compose.yaml)
  if [[ "${revolut_mode}" == "sandbox" ]]; then
    if [[ ! -f "${previous_release}/compose.sandbox.yaml" ]]; then
      echo "ROLLBACK_FAILED: previous Sandbox overlay is missing." >&2
      return 1
    fi
    rollback_compose_args+=(-f compose.sandbox.yaml)
  fi

  cd "${previous_release}"
  if IMAGE_TAG="${previous_sha}" REVOLUT_ENV_FILE="${env_file}" \
    docker compose "${rollback_compose_args[@]}" up -d --remove-orphans --wait --wait-timeout 90; then
    ln -sfn "${previous_release}" "${app_root}/current"
    echo "ROLLBACK_OK release=${previous_sha}"
    return 0
  fi

  echo "ROLLBACK_FAILED: previous release could not be reactivated." >&2
  return 1
}

cd "${release_dir}"
export IMAGE_TAG="${release_sha}"
export REVOLUT_ENV_FILE="${env_file}"

docker compose "${compose_args[@]}" build --pull
candidate_wait_timeout=90
if [[ "${revolut_mode}" == "sandbox" ]]; then
  candidate_wait_timeout=360
fi
if ! docker compose "${compose_args[@]}" up -d --remove-orphans --wait \
  --wait-timeout "${candidate_wait_timeout}"; then
  echo "Candidate release failed to start; attempting rollback." >&2
  rollback_previous_release || true
  exit 1
fi

if ! health_response="$(curl --fail --silent --show-error \
    --retry 8 \
    --retry-delay 2 \
    --retry-all-errors \
    http://127.0.0.1:3000/health)"; then
  echo "Candidate health check failed; attempting rollback." >&2
  rollback_previous_release || true
  exit 1
fi

if [[ "${health_response}" != *"\"mode\":\"${revolut_mode}\""* ]]; then
  echo "Health response did not confirm ${revolut_mode} mode: ${health_response}" >&2
  rollback_previous_release || true
  exit 1
fi

ln -sfn "${release_dir}" "${app_root}/current"
if [[ "${revolut_mode}" == "sandbox" ]]; then
  if ! bash "${release_dir}/scripts/deploy/install-sqlite-backup-cron.sh"; then
    echo "Backup schedule installation failed; attempting rollback." >&2
    rollback_previous_release || true
    exit 1
  fi
  if ! bash "${release_dir}/scripts/deploy/run-remote-smoke-test.sh" "${release_sha}"; then
    echo "Remote Sandbox smoke test failed; attempting rollback." >&2
    rollback_previous_release || true
    exit 1
  fi
fi
docker image prune -f

echo "Activated ${release_sha}: ${health_response}"
