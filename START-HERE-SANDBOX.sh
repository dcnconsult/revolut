#!/usr/bin/env bash

# Beginner-friendly launcher for Revolut Business Sandbox tasks.
# Run with: bash START-HERE-SANDBOX.sh

set -u

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

pause_for_user() {
  printf '\nPress Enter to return to the menu...'
  read -r _
}

show_header() {
  if command -v clear >/dev/null 2>&1; then
    clear
  fi
  cat <<'HEADER'
============================================================
 REVOLUTE - Revolut Business Sandbox Helper for Linux
============================================================

This helper uses Revolut Sandbox only.
It does not send a Production payment.

Never share or upload these private files:
  .secrets/sandbox/privatecert.pem
  .secrets/sandbox/tokens.json
HEADER
}

check_prerequisites() {
  local failed=0

  if ! command -v node >/dev/null 2>&1; then
    echo "FAILED: Node.js was not found."
    echo "Install Node.js 22 or newer, then run this helper again."
    failed=1
  else
    local node_major
    node_major="$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)"
    if [ "$node_major" -lt 22 ]; then
      echo "FAILED: Node.js 22 or newer is required."
      echo "Installed version: $(node --version 2>/dev/null || echo unknown)"
      failed=1
    fi
  fi

  if ! command -v npm >/dev/null 2>&1; then
    echo "FAILED: npm was not found."
    echo "Install npm with Node.js, then run this helper again."
    failed=1
  fi

  if ! command -v openssl >/dev/null 2>&1; then
    echo "FAILED: OpenSSL was not found."
    echo "On Ubuntu or Debian, run: sudo apt update && sudo apt install -y openssl"
    failed=1
  fi

  if [ "$failed" -ne 0 ]; then
    return 1
  fi

  return 0
}

install_dependencies_if_needed() {
  if [ ! -f "node_modules/jose/package.json" ]; then
    echo
    echo "Installing the project files needed for testing..."
    echo "Many lines may appear. That is normal."
    echo
    if ! npm ci; then
      echo
      echo "FAILED: Project installation did not finish."
      echo "Copy only the final error message to the project maintainer."
      echo "Never include certificate files or tokens."
      return 1
    fi
  fi
  return 0
}

run_action() {
  local command_name="$1"
  if npm run "$command_name"; then
    echo
    echo "SUCCESS: The selected action finished."
  else
    echo
    echo "FAILED: The selected action did not finish."
    echo "Copy only the final error message to the project maintainer."
    echo "Never include certificate files, authorization codes, or tokens."
  fi
  pause_for_user
}

show_header
if ! check_prerequisites; then
  echo
  echo "Fix the item above, then run:"
  echo "  bash START-HERE-SANDBOX.sh"
  exit 1
fi

if ! install_dependencies_if_needed; then
  exit 1
fi

while true; do
  show_header
  cat <<'MENU'

Choose one action:

  1. First-time Revolut Sandbox setup
  2. Test the saved Sandbox account connection
  3. Add test funds to a Sandbox account
  4. Run all safe local code tests
  5. Close
MENU
  printf '\nType 1, 2, 3, 4, or 5: '
  read -r choice

  case "$choice" in
    1) run_action "sandbox:setup" ;;
    2) run_action "sandbox:accounts" ;;
    3) run_action "sandbox:topup" ;;
    4) run_action "check" ;;
    5)
      echo "Closed without changing Production."
      exit 0
      ;;
    *)
      echo "Please type only 1, 2, 3, 4, or 5."
      pause_for_user
      ;;
  esac
done
