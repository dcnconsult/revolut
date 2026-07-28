#!/usr/bin/env bash

# Installs the one-click Revolut Sandbox SSH tunnel launcher for one Linux Mint user.
# Run this script as the desktop user, never with sudo.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_ID="com.dcnconsult.RevolutSandbox"
SERVICE_NAME="revolut-sandbox-tunnel.service"

SERVER_HOST=""
SSH_USER="deploy"
SSH_PORT="22"
LOCAL_PORT="3000"
REMOTE_PORT="3000"
IDENTITY_SOURCE=""
KNOWN_HOSTS_SOURCE=""
REPLACE="no"
CREATE_DESKTOP_SHORTCUT="yes"
VERIFY_CONNECTION="yes"

usage() {
  cat <<'USAGE'
Install the one-click Revolut Sandbox launcher for the current Linux Mint user.

Usage:
  ./install.sh \
    --host SERVER_NAME_OR_IP \
    --identity /path/to/private_key \
    --known-hosts /path/to/verified_known_hosts

Options:
  --host VALUE             Approved Droplet hostname or IP address (required)
  --ssh-user VALUE         SSH account name (default: deploy)
  --ssh-port VALUE         SSH server port (default: 22)
  --local-port VALUE       Port used by the Mint browser (default: 3000)
  --remote-port VALUE      Loopback application port on the server (default: 3000)
  --identity FILE          Dedicated SSH private key (required)
  --known-hosts FILE       Pre-verified known_hosts file (required)
  --replace                Replace an existing launcher installation
  --no-desktop-shortcut    Add the Mint menu entry but not a Desktop icon
  --skip-connection-test   Install without opening and verifying the application
  --help                   Show this help

The private key is copied into the user's private application-data directory.
Do not place it in Git, a Docker image, email, or an unencrypted installer.
USAGE
}

fail() {
  printf 'INSTALLATION STOPPED: %s\n' "$*" >&2
  exit 1
}

require_value() {
  if [[ "$#" -lt 2 || -z "$2" ]]; then
    fail "$1 requires a value."
  fi
}

validate_port() {
  local label="$1"
  local value="$2"
  if [[ ! "$value" =~ ^[0-9]+$ ]] ||
    (( 10#$value < 1 || 10#$value > 65535 )); then
    fail "$label must be a number from 1 through 65535."
  fi
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --host)
      require_value "$@"
      SERVER_HOST="$2"
      shift 2
      ;;
    --ssh-user)
      require_value "$@"
      SSH_USER="$2"
      shift 2
      ;;
    --ssh-port)
      require_value "$@"
      SSH_PORT="$2"
      shift 2
      ;;
    --local-port)
      require_value "$@"
      LOCAL_PORT="$2"
      shift 2
      ;;
    --remote-port)
      require_value "$@"
      REMOTE_PORT="$2"
      shift 2
      ;;
    --identity)
      require_value "$@"
      IDENTITY_SOURCE="$2"
      shift 2
      ;;
    --known-hosts)
      require_value "$@"
      KNOWN_HOSTS_SOURCE="$2"
      shift 2
      ;;
    --replace)
      REPLACE="yes"
      shift
      ;;
    --no-desktop-shortcut)
      CREATE_DESKTOP_SHORTCUT="no"
      shift
      ;;
    --skip-connection-test)
      VERIFY_CONNECTION="no"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "Unknown option: $1. Run with --help for usage."
      ;;
  esac
done

[[ "${EUID}" -ne 0 ]] || fail "Run this installer as the Mint desktop user, not with sudo."
[[ -n "$SERVER_HOST" ]] || fail "--host is required."
[[ -n "$IDENTITY_SOURCE" ]] || fail "--identity is required."
[[ -n "$KNOWN_HOSTS_SOURCE" ]] || fail "--known-hosts is required."
[[ "$SERVER_HOST" =~ ^[A-Za-z0-9._:-]+$ ]] || fail "The server hostname contains unsupported characters."
[[ "$SSH_USER" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] || fail "The SSH user name is not valid."
[[ "$HOME" != *$'\n'* && "$HOME" != *" "* ]] || fail "The user home path cannot contain spaces or newlines."

validate_port "SSH port" "$SSH_PORT"
validate_port "Local port" "$LOCAL_PORT"
validate_port "Remote port" "$REMOTE_PORT"

for command_name in ssh ssh-keygen curl xdg-open install sed grep mktemp flock; do
  command -v "$command_name" >/dev/null 2>&1 ||
    fail "Required program '$command_name' is missing. Install openssh-client, curl, xdg-utils, and util-linux first."
done
if ! command -v zenity >/dev/null 2>&1 &&
  ! command -v notify-send >/dev/null 2>&1; then
  fail "A graphical error notifier is required. Install zenity or libnotify-bin first."
fi

for required_template in \
  "$SCRIPT_DIR/launch.sh.in" \
  "$SCRIPT_DIR/direct-tunnel.sh.in" \
  "$SCRIPT_DIR/com.dcnconsult.RevolutSandbox.desktop.in"; do
  [[ -r "$required_template" ]] || fail "Installer component is missing: $required_template"
done

[[ -s "$IDENTITY_SOURCE" && -r "$IDENTITY_SOURCE" ]] ||
  fail "The private-key file is missing, empty, or unreadable."
grep -q "PRIVATE KEY" "$IDENTITY_SOURCE" ||
  fail "The identity file does not look like a private SSH key."
[[ -s "$KNOWN_HOSTS_SOURCE" && -r "$KNOWN_HOSTS_SOURCE" ]] ||
  fail "The verified known_hosts file is missing, empty, or unreadable."

HOST_LOOKUP="$SERVER_HOST"
if [[ "$SSH_PORT" != "22" ]]; then
  HOST_LOOKUP="[$SERVER_HOST]:$SSH_PORT"
fi
ssh-keygen -F "$HOST_LOOKUP" -f "$KNOWN_HOSTS_SOURCE" >/dev/null ||
  fail "The known_hosts file has no verified key for $HOST_LOOKUP."

CONFIG_DIR="$HOME/.config/revolut-sandbox"
DATA_DIR="$HOME/.local/share/revolut-sandbox"
LIBEXEC_DIR="$HOME/.local/lib/revolut-sandbox"
APPLICATIONS_DIR="$HOME/.local/share/applications"
USER_SERVICE_DIR="$HOME/.config/systemd/user"
SSH_CONFIG="$CONFIG_DIR/ssh_config"
INSTALLED_IDENTITY="$DATA_DIR/tunnel_identity"
INSTALLED_KNOWN_HOSTS="$DATA_DIR/known_hosts"
LAUNCHER="$LIBEXEC_DIR/launch.sh"
DIRECT_TUNNEL="$LIBEXEC_DIR/direct-tunnel.sh"
DESKTOP_ENTRY="$APPLICATIONS_DIR/$APP_ID.desktop"
LEGACY_SERVICE_FILE="$USER_SERVICE_DIR/$SERVICE_NAME"

if [[ -e "$SSH_CONFIG" && "$REPLACE" != "yes" ]]; then
  fail "A launcher is already installed. Use --replace only after confirming the new access files."
fi

if [[ "$REPLACE" == "yes" ]]; then
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user stop "$SERVICE_NAME" >/dev/null 2>&1 || true
  fi
fi

STAGING_DIR="$(mktemp -d)"
cleanup() {
  rm -rf -- "$STAGING_DIR"
}
trap cleanup EXIT
umask 077

install -m 600 "$IDENTITY_SOURCE" "$STAGING_DIR/tunnel_identity"
install -m 600 "$KNOWN_HOSTS_SOURCE" "$STAGING_DIR/known_hosts"

cat >"$STAGING_DIR/ssh_config" <<EOF
Host revolut-sandbox-tunnel
    HostName $SERVER_HOST
    User $SSH_USER
    Port $SSH_PORT
    IdentityFile $INSTALLED_IDENTITY
    IdentitiesOnly yes
    BatchMode yes
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    StrictHostKeyChecking yes
    UserKnownHostsFile $INSTALLED_KNOWN_HOSTS
    UpdateHostKeys no
    CheckHostIP no
    ForwardAgent no
    ForwardX11 no
    PermitLocalCommand no
    RequestTTY no
    ExitOnForwardFailure yes
    ServerAliveInterval 15
    ServerAliveCountMax 3
    ConnectTimeout 10
    LocalForward 127.0.0.1:$LOCAL_PORT 127.0.0.1:$REMOTE_PORT
EOF

SSH_PATH="$(command -v ssh)"
sed \
  -e "s|@LOCAL_PORT@|$LOCAL_PORT|g" \
  "$SCRIPT_DIR/launch.sh.in" >"$STAGING_DIR/launch.sh"
sed \
  -e "s|@SSH_PATH@|$SSH_PATH|g" \
  "$SCRIPT_DIR/direct-tunnel.sh.in" >"$STAGING_DIR/direct-tunnel.sh"
sed \
  -e "s|@LAUNCHER_PATH@|$LAUNCHER|g" \
  "$SCRIPT_DIR/com.dcnconsult.RevolutSandbox.desktop.in" >"$STAGING_DIR/$APP_ID.desktop"

install -d -m 700 "$CONFIG_DIR" "$DATA_DIR" "$LIBEXEC_DIR"
install -d -m 755 "$APPLICATIONS_DIR"
install -m 600 "$STAGING_DIR/tunnel_identity" "$INSTALLED_IDENTITY"
install -m 600 "$STAGING_DIR/known_hosts" "$INSTALLED_KNOWN_HOSTS"
install -m 600 "$STAGING_DIR/ssh_config" "$SSH_CONFIG"
install -m 700 "$STAGING_DIR/launch.sh" "$LAUNCHER"
install -m 700 "$STAGING_DIR/direct-tunnel.sh" "$DIRECT_TUNNEL"
install -m 755 "$STAGING_DIR/$APP_ID.desktop" "$DESKTOP_ENTRY"

if [[ "$REPLACE" == "yes" && -f "$LEGACY_SERVICE_FILE" ]]; then
  rm -f -- "$LEGACY_SERVICE_FILE"
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user daemon-reload >/dev/null 2>&1 || true
  fi
fi

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APPLICATIONS_DIR" >/dev/null 2>&1 || true
fi

if [[ "$CREATE_DESKTOP_SHORTCUT" == "yes" ]]; then
  if command -v xdg-user-dir >/dev/null 2>&1; then
    DESKTOP_DIR="$(xdg-user-dir DESKTOP)"
  else
    DESKTOP_DIR="$HOME/Desktop"
  fi
  if [[ -n "$DESKTOP_DIR" && -d "$DESKTOP_DIR" ]]; then
    DESKTOP_SHORTCUT="$DESKTOP_DIR/Revolut Sandbox.desktop"
    install -m 755 "$STAGING_DIR/$APP_ID.desktop" "$DESKTOP_SHORTCUT"
    if command -v gio >/dev/null 2>&1; then
      gio set "$DESKTOP_SHORTCUT" metadata::trusted true >/dev/null 2>&1 || true
    fi
  fi
fi

printf '\nINSTALLATION COMPLETE\n'
printf 'The operator can now click "Revolut Sandbox" in the Mint application menu'
if [[ "$CREATE_DESKTOP_SHORTCUT" == "yes" ]]; then
  printf ' or on the Desktop'
fi
printf '.\n'
printf 'The first connection can take up to 30 seconds. No terminal is required.\n'

if [[ "$VERIFY_CONNECTION" == "yes" ]]; then
  printf '\nTesting the complete tunnel and opening the Sandbox login page...\n'
  if ! "$LAUNCHER"; then
    printf 'CONNECTION TEST FAILED\n' >&2
    printf 'The launcher is installed, but its first connection did not succeed.\n' >&2
    printf 'Resolve the administrator-side access issue before handing this computer to the operator.\n' >&2
    exit 1
  fi
  printf 'CONNECTION VERIFIED: the approved Sandbox application opened successfully.\n'
fi
