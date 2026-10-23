#!/bin/sh
# gateway-back reads and rewrites ./config.json at runtime (the UI's settings page saves to
# it), so only create it when it doesn't exist yet. To start over: delete the /data volume.
set -eu

if [ ! -f config.json ]; then
    cat > config.json <<EOF
{
  "cloud_address": "${GATEWAY_CLOUD_ADDRESS}",
  "server_port": ":8080",
  "tenant_id": "${GATEWAY_TENANT_ID}"
}
EOF
    echo "docker-entrypoint: created config.json (cloud_address=${GATEWAY_CLOUD_ADDRESS}, tenant_id=${GATEWAY_TENANT_ID})"
else
    echo "docker-entrypoint: using existing config.json"
fi

exec "$@"
