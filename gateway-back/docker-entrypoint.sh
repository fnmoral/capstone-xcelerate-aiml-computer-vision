#!/bin/sh
# gateway-back reads and rewrites ./config.json at runtime (the UI's settings page saves to
# it, and the gateway itself fills in the real tenant/gateway IDs once it registers with the
# backend and flips gateway_information_updated to true), so only create it when it doesn't
# exist yet. To start over: delete the /data volume.
set -eu

if [ ! -f config.json ]; then
    cat > config.json <<EOF
{
  "stream_hub_address": "${GATEWAY_STREAM_HUB_ADDRESS}",
  "back_end_address": "${GATEWAY_BACKEND_ADDRESS}",
  "server_port": ":8080",
  "tenant_id": "${GATEWAY_TENANT_ID}",
  "tenant_name": "${GATEWAY_TENANT_NAME}",
  "gateway_name_id": "${GATEWAY_NAME_ID}",
  "gateway_id": "${GATEWAY_ID}",
  "gateway_information_updated": false
}
EOF
    echo "docker-entrypoint: created config.json (stream_hub_address=${GATEWAY_STREAM_HUB_ADDRESS}, " \
         "back_end_address=${GATEWAY_BACKEND_ADDRESS}, tenant_id=${GATEWAY_TENANT_ID})"
else
    echo "docker-entrypoint: using existing config.json"
fi

exec "$@"