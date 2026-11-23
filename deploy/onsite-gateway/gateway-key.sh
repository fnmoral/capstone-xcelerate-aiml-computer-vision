#!/bin/bash
# Run once on the computer that will host an on-site gateway (Git Bash, WSL, macOS or Linux):
#   bash deploy/onsite-gateway/gateway-key.sh
# Creates the gateway's SSH key (if it has none) and prints what to send the FallGuard admin.
set -euo pipefail
KEY=${FALLGUARD_GATEWAY_KEY:-$HOME/.ssh/fallguard_gateway}
mkdir -p "$(dirname "$KEY")"
chmod 700 "$(dirname "$KEY")" 2>/dev/null || true
[ -f "$KEY" ] || ssh-keygen -q -t ed25519 -N "" -C "fallguard-gateway-$(whoami)@$(hostname)" -f "$KEY"
IP=$(curl -s -m 8 https://api.ipify.org || true)

cat <<EOF

Send this to your FallGuard admin (a public key: safe to share):

  Name / place:  <your name and where the cameras are>
  Public IP:     ${IP:-unknown (look it up at https://api.ipify.org)}
  Key:           $(cat "$KEY.pub")

Keep $KEY itself private. The admin replies with your port (18081, 18082, ...).
EOF
