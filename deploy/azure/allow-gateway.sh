#!/bin/bash
# Lets an on-site gateway connect to this VM: its SSH key may only open its own port (the
# API reaches the gateway there) and reach stream-hub (8090) and the API (8100). Run on the VM
# as root, e.g. Azure portal -> fallguard-vm -> Run command -> RunShellScript:
#   bash /data/capstone/deploy/azure/allow-gateway.sh 18081 'ssh-ed25519 AAAA... name'
# Also creates the restricted "tunnel" user (no shell, forwarding only) if it doesn't exist.
# Remove a gateway: delete its line from /home/tunnel/.ssh/authorized_keys.
set -euo pipefail
PORT=${1:?usage: allow-gateway.sh <port 18080-18099> '<ssh public key>'}
KEY=${2:?usage: allow-gateway.sh <port 18080-18099> '<ssh public key>'}
[[ "$PORT" =~ ^180[89][0-9]$ ]] || { echo "port must be 18080-18099" >&2; exit 2; }
[[ "$KEY" =~ ^ssh-(ed25519|rsa)\ [A-Za-z0-9+/=]+( .*)?$ ]] || { echo "not an SSH public key" >&2; exit 2; }

# The tunnel user and its sshd settings (once).
id tunnel >/dev/null 2>&1 || useradd --create-home --shell /usr/sbin/nologin tunnel
install -d -m 700 -o tunnel -g tunnel /home/tunnel/.ssh
AK=/home/tunnel/.ssh/authorized_keys
touch "$AK"
CONF=/etc/ssh/sshd_config.d/60-fallguard-tunnel.conf
if [ ! -f "$CONF" ]; then
  cat > "$CONF" <<'EOF'
Match User tunnel
    GatewayPorts clientspecified
    AllowTcpForwarding yes
    PermitTTY no
    X11Forwarding no
    AllowAgentForwarding no
    ClientAliveInterval 30
    ClientAliveCountMax 3
EOF
  mkdir -p /run/sshd
  sshd -t
  if systemctl is-active --quiet ssh; then systemctl reload ssh; fi
fi

# One line per gateway; a port belongs to one key.
KEYDATA=$(echo "$KEY" | awk '{print $1" "$2}')
if grep -qF "$KEYDATA" "$AK"; then
  echo "this key is already allowed:"; grep -F "$KEYDATA" "$AK" | grep -o 'permitlisten="[^"]*"'
  exit 0
fi
if grep -q "permitlisten=\"0.0.0.0:$PORT\"" "$AK"; then
  echo "port $PORT is already used by another gateway; pick another" >&2
  exit 1
fi
echo "restrict,port-forwarding,permitlisten=\"0.0.0.0:$PORT\",permitopen=\"127.0.0.1:8090\",permitopen=\"127.0.0.1:8100\" $KEY" >> "$AK"
chown tunnel:tunnel "$AK"
chmod 600 "$AK"
echo "gateway allowed on port $PORT ($(grep -c 'permitlisten="0.0.0.0:180' "$AK") gateway key(s) in total)"
