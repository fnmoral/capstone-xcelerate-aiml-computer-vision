#!/bin/bash
# Rebuild and restart FallGuard on the Azure VM with the code now checked out in ~/capstone.
# Run by the post-receive hook after each push of the deploy branch, or by hand.
set -euo pipefail
cd /data/capstone
echo "== deploy $(git rev-parse --abbrev-ref HEAD) $(git log --oneline -1) at $(date -u '+%Y-%m-%d %H:%M UTC')"
SERVICES="db partitions api stream-hub frontend caddy test-camera"
# An on-site gateway in use (gateway-mode.sh onsite): keep the VM's own gateway stopped.
if grep -q '^GATEWAY_URL=http://host.docker.internal:18080$' .env; then
    echo "gateway mode: onsite (the VM's gateway stays stopped)"
else
    SERVICES="$SERVICES gateway-back"
fi
# shellcheck disable=SC2086
docker compose -f docker-compose.yml -f docker-compose.azure.yml up -d --build $SERVICES
docker image prune -f >/dev/null   # drop the replaced images (keeps the disk from filling up)
docker compose -f docker-compose.yml -f docker-compose.azure.yml ps --format '{{.Service}}: {{.Status}}'
echo "== done at $(date -u '+%H:%M UTC')"
