#!/bin/bash
# One-time setup of the FallGuard Azure VM (Ubuntu 24.04 ARM64). Safe to run again.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

# ---- data disk (LUN 0) at /data: format only if it has no filesystem yet ----
DEV=$(readlink -f /dev/disk/azure/data/by-lun/0 2>/dev/null || readlink -f /dev/disk/azure/scsi1/lun0)
echo "data disk: $DEV"
if ! blkid "$DEV" >/dev/null 2>&1; then
  echo "formatting $DEV (new, empty disk)"
  mkfs.ext4 -q -L fallguard-data "$DEV"
fi
mkdir -p /data
UUID=$(blkid -s UUID -o value "$DEV")
grep -q "$UUID" /etc/fstab || echo "UUID=$UUID /data ext4 defaults,nofail,discard 0 2" >> /etc/fstab
mountpoint -q /data || mount /data
df -h /data | tail -1

# ---- swap (2 GB on the OS disk): headroom for image builds ----
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap -q /swapfile
  echo "/swapfile none swap sw 0 0" >> /etc/fstab
fi
swapon --show | grep -q /swapfile || swapon /swapfile

# ---- Docker (official repo), data on /data/docker ----
if ! command -v docker >/dev/null; then
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl git
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
mkdir -p /data/docker /etc/docker
if ! grep -q '/data/docker' /etc/docker/daemon.json 2>/dev/null; then
  systemctl stop docker docker.socket || true
  cat > /etc/docker/daemon.json <<'JSON'
{
  "data-root": "/data/docker",
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
JSON
fi
# Docker must wait for the data disk at boot.
mkdir -p /etc/systemd/system/docker.service.d
cat > /etc/systemd/system/docker.service.d/wait-for-data.conf <<'UNIT'
[Unit]
RequiresMountsFor=/data
UNIT
systemctl daemon-reload
systemctl enable --now docker
usermod -aG docker fallguard

# ---- automatic security updates ----
apt-get install -y -qq unattended-upgrades >/dev/null
echo "docker root: $(docker info --format '{{.DockerRootDir}}')  arch: $(uname -m)"
docker compose version
