#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this one-time provisioning command as root." >&2
  exit 1
fi

deploy_user="${DEPLOY_USER:-deploy}"
sandbox_dir="/etc/revolut/sandbox"
release_dir="${RELEASE_DIR:-$(readlink -f /opt/revolut/current)}"
auth_file="${sandbox_dir}/operator-auth.json"
token_file="${sandbox_dir}/automation-token"

if [[ -e "${auth_file}" || -e "${token_file}" ]]; then
  echo "Operator access already exists. Refusing to overwrite credentials." >&2
  exit 1
fi
if [[ ! -f "${release_dir}/scripts/operator/create-credentials.mjs" ]]; then
  echo "Credential generator is missing from ${release_dir}." >&2
  exit 1
fi

install -d -o root -g "${deploy_user}" -m 0750 "${sandbox_dir}"
generator_output="$(docker run --rm \
  --volume "${release_dir}:/workspace:ro" \
  --volume "${sandbox_dir}:/output" \
  node:22-bookworm-slim \
  node /workspace/scripts/operator/create-credentials.mjs \
    --output /output/operator-auth.json \
    --admin admin \
    --viewer viewer)"

automation_token="$(sed -n 's/^AUTOMATION_TOKEN=//p' <<<"${generator_output}")"
if [[ -z "${automation_token}" ]]; then
  rm -f -- "${auth_file}"
  echo "Credential generation did not return an automation token." >&2
  exit 1
fi
printf '%s\n' "${automation_token}" >"${token_file}"
chown root:"${deploy_user}" "${auth_file}" "${token_file}"
chmod 0640 "${auth_file}" "${token_file}"

sed '/^AUTOMATION_TOKEN=/d' <<<"${generator_output}"
echo "The automation token was installed without being displayed."
echo "Store both displayed passwords in your password manager now; they cannot be recovered."
