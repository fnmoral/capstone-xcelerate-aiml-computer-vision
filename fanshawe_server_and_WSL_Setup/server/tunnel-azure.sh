#!/bin/sh
# Connects ml-service on this machine (the Fanshawe server) to FallGuard on Azure, and keeps
# the connection open (reconnects every 10 s if it drops). Runs on the server:
#   sh fallguard/tunnel-azure.sh          # start (or restart)
#   sh fallguard/tunnel-azure.sh stop
# Through one outgoing SSH connection to the VM's "tunnel" user (port forwarding only):
#   VM 0.0.0.0:9999  -> here localhost:9999   stream-hub sends video to ml-service
#   here 127.0.0.1:15432 -> VM 127.0.0.1:5433 ml-service writes to the database
# Needs ~/.ssh/fallguard_tunnel (its .pub is in the VM's /home/tunnel/.ssh/authorized_keys) and
# the VM's host key in ~/.ssh/known_hosts_fallguard. Start ml-service with start-ml.sh.
set -eu
VM=${FALLGUARD_VM:-fallguard-vision.canadacentral.cloudapp.azure.com}
LOG=~/fallguard/tunnel.log

pkill -f "[f]allguard-tunnel-loop" || true
pkill -f "[s]sh -N .*fallguard_tunnel" || true
[ "${1:-}" = stop ] && { echo "tunnel stopped"; exit 0; }

setsid nohup sh -c '
  # fallguard-tunnel-loop
  while true; do
    echo "$(date "+%F %T") connecting to '"$VM"'"
    ssh -N -i ~/.ssh/fallguard_tunnel \
      -o UserKnownHostsFile=~/.ssh/known_hosts_fallguard -o StrictHostKeyChecking=yes \
      -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
      -o ConnectTimeout=15 -o BatchMode=yes \
      -R 0.0.0.0:9999:localhost:9999 -L 15432:127.0.0.1:5433 tunnel@'"$VM"'
    echo "$(date "+%F %T") disconnected (exit $?), retrying in 10 s"
    sleep 10
  done' > "$LOG" 2>&1 < /dev/null &
echo "tunnel started (log: $LOG)"
