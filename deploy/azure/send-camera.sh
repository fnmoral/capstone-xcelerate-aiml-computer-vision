#!/bin/bash
# Send a camera on this network (e.g. a phone RTSP app at home) to the FallGuard VM on Azure.
# The VM can't reach home addresses, so this machine reads the camera and pushes the video
# through an SSH tunnel to the VM's relay. In the app, add the camera as
#   rtsp://test-camera:8554/<name>
#
# Run in WSL (or any Linux/Mac with Docker and ssh), and leave it running:
#   bash deploy/azure/send-camera.sh rtsp://10.0.0.200:8554/ phone1
#
# Needs: the VM SSH key at ~/.ssh/fallguard_azure (copy it from Windows: C:\Users\<you>\.ssh\),
# Docker (for ffmpeg, from the relay image). Ctrl+C stops it.
set -euo pipefail
SRC=${1:?usage: send-camera.sh <camera rtsp url> [name]}
NAME=${2:-phone1}
HOST=${FALLGUARD_VM:-fallguard@fallguard-vision.canadacentral.cloudapp.azure.com}
KEY=${FALLGUARD_KEY:-$HOME/.ssh/fallguard_azure}
PORT=18554                        # local end of the tunnel to the VM's relay (127.0.0.1:8554)

if [ ! -f "$KEY" ] && [ -f "/mnt/c/Users/${USER_WIN:-$USER}/.ssh/fallguard_azure" ]; then
  mkdir -p ~/.ssh && cp "/mnt/c/Users/${USER_WIN:-$USER}/.ssh/fallguard_azure" "$KEY"
fi
[ -f "$KEY" ] || { echo "SSH key not found at $KEY (set FALLGUARD_KEY)"; exit 1; }
chmod 600 "$KEY"

echo "Tunnel to the VM relay..."
ssh -f -N -i "$KEY" -o ExitOnForwardFailure=yes -o ServerAliveInterval=20 -o StrictHostKeyChecking=accept-new \
    -L "$PORT:127.0.0.1:8554" "$HOST"
TUNNEL=$(pgrep -n -f "ssh -f -N -i $KEY.*$PORT:127.0.0.1:8554") || true
trap '[ -n "${TUNNEL:-}" ] && kill "$TUNNEL" 2>/dev/null; echo stopped' EXIT

echo "Sending $SRC to the VM as rtsp://test-camera:8554/$NAME (Ctrl+C to stop)"
while true; do
  # Copy the video as it is (no re-encoding, low CPU); drop audio. Reconnects if the camera drops.
  docker run --rm --network host --entrypoint ffmpeg bluenviron/mediamtx:1.21.2-ffmpeg \
    -hide_banner -loglevel warning -rtsp_transport tcp -i "$SRC" -an -c:v copy \
    -f rtsp -rtsp_transport tcp "rtsp://127.0.0.1:$PORT/$NAME" || true
  echo "camera or tunnel dropped; retrying in 5 s"
  sleep 5
done
