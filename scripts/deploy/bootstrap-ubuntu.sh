#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this bootstrap as root." >&2
  exit 1
fi

DEPLOY_USER="${DEPLOY_USER:-deploy}"
SSH_PORT="${SSH_PORT:-22}"
APP_ROOT="/opt/revolut"
ENV_DIR="/etc/revolut"

if ! id "${DEPLOY_USER}" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "${DEPLOY_USER}"
fi

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  ca-certificates \
  curl \
  docker.io \
  docker-compose-v2 \
  rsync \
  ufw

systemctl enable --now docker
usermod --append --groups docker "${DEPLOY_USER}"

install -d -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" -m 0750 \
  "${APP_ROOT}" \
  "${APP_ROOT}/releases"
install -d -o root -g "${DEPLOY_USER}" -m 0750 "${ENV_DIR}"

if [[ -s /root/.ssh/authorized_keys ]]; then
  deploy_home="$(getent passwd "${DEPLOY_USER}" | cut -d: -f6)"
  install -d -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" -m 0700 \
    "${deploy_home}/.ssh"
  install -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" -m 0600 \
    /root/.ssh/authorized_keys \
    "${deploy_home}/.ssh/authorized_keys"
fi

if [[ ! -e "${ENV_DIR}/revolut.env" ]]; then
  install -o root -g "${DEPLOY_USER}" -m 0640 /dev/null \
    "${ENV_DIR}/revolut.env"
  cat >"${ENV_DIR}/revolut.env" <<'EOF'
NODE_ENV=production
PORT=3000
LOG_LEVEL=info
REVOLUT_MODE=mock
PAYMENT_MAX_AMOUNT_MINOR=100000000
PAYMENT_ALLOWED_CURRENCIES=EUR,GBP,CHF,USD
PAYMENT_REQUIRE_NAME_MATCH=true
ISO20022_MAX_FILE_BYTES=2000000
ISO20022_MAX_TRANSACTIONS=100
ISO20022_MAX_XML_ELEMENTS=20000
ISO20022_MAX_XML_DEPTH=64
ISO20022_STRUCTURED_ADDRESS_CUTOFF=2026-11-15
EOF
fi

ufw default deny incoming
ufw default allow outgoing
ufw allow "${SSH_PORT}/tcp" comment "SSH"
ufw --force enable

echo
echo "Bootstrap complete."
echo "Before disabling root SSH, open a second session and verify:"
echo "  ssh -p ${SSH_PORT} ${DEPLOY_USER}@<droplet-ip>"
echo "The API will remain bound to 127.0.0.1:3000."
