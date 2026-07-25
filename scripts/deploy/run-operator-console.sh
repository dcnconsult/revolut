#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ! -t 0 || ! -t 1 ]]; then
  echo "Run this command from an interactive Droplet terminal." >&2
  exit 2
fi
if ! docker inspect --format '{{.State.Running}}' revolut-api-1 2>/dev/null |
    grep -Fxq true; then
  echo "The Revolut API container is not running." >&2
  exit 1
fi
if [[ "$(docker port revolut-api-1 3000/tcp)" != "127.0.0.1:3000" ]]; then
  echo "Refusing to start: the API is not loopback-only." >&2
  exit 1
fi

exec docker exec -it revolut-api-1 node scripts/operator/console.mjs
