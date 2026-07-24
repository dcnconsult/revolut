#!/usr/bin/env bash
set -Eeuo pipefail

current_release="$(readlink -f /opt/revolut/current)"
image_tag="$(basename "${current_release}")"
docker run --rm --user 0 \
  --mount type=bind,source="${current_release}",target=/source,readonly \
  --mount type=bind,source=/etc/cron.d,target=/cron-target \
  --mount type=bind,source=/var/backups,target=/backup-target \
  "revolut-api:${image_tag}" sh -ceu '
    install -d -m 0700 -o 1000 -g 1000 /backup-target/revolut
    install -m 0644 -o 0 -g 0 /source/scripts/deploy/revolut-sqlite-backup.cron /cron-target/revolut-sqlite-backup
  '
echo "SQLITE_BACKUP_CRON_OK schedule='17 3 * * 0' timezone=server"
