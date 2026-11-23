#!/bin/bash
# Which gateway the app on the VM uses (one at a time). Run on the VM:
#   bash deploy/azure/gateway-mode.sh onsite   # the gateway next to the cameras (deploy/onsite-gateway),
#                                              # through its SSH tunnel; the VM's own gateway stops
#   bash deploy/azure/gateway-mode.sh vm       # back to the VM's gateway (phone cameras, send-camera.sh)
#   bash deploy/azure/gateway-mode.sh          # show the current mode
# Cameras belong to a gateway: each mode shows its own gateway's cameras.
set -euo pipefail
cd /data/capstone
ONSITE_URL=http://host.docker.internal:18080
compose() { docker compose -f docker-compose.yml -f docker-compose.azure.yml "$@"; }
current() { grep -q "^GATEWAY_URL=$ONSITE_URL$" .env && echo onsite || echo vm; }

case "${1:-}" in
  "") echo "gateway mode: $(current)"; exit 0 ;;
  onsite)
    sed -i '/^GATEWAY_URL=/d' .env
    echo "GATEWAY_URL=$ONSITE_URL" >> .env
    compose stop gateway-back
    compose up -d api ;;
  vm)
    sed -i '/^GATEWAY_URL=/d' .env
    compose up -d api gateway-back ;;
  *) echo "usage: $0 [onsite|vm]" >&2; exit 2 ;;
esac
echo "gateway mode: $(current)"
