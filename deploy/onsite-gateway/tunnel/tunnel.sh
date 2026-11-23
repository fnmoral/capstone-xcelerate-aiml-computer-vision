#!/bin/sh
# Keeps the on-site gateway connected to the Azure VM; exits when the connection drops, and
# Docker restarts it. The key is mounted read-only; ssh wants a private copy (mode 600).
set -eu
install -m 600 /run/secrets/key /tmp/key
echo "connecting to $VM"
exec ssh -N -i /tmp/key \
    -o StrictHostKeyChecking=yes -o BatchMode=yes -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ConnectTimeout=15 \
    -L 0.0.0.0:8090:127.0.0.1:8090 \
    -L 0.0.0.0:8100:127.0.0.1:8100 \
    -R "0.0.0.0:${GATEWAY_TUNNEL_PORT:-18080}:gateway:8080" \
    "tunnel@$VM"
