#!/bin/bash
# One-time setup of Docker Engine + NVIDIA GPU support inside WSL 2 Ubuntu (also works on
# a plain Ubuntu server). Run as root:
#
#   wsl -d Ubuntu-24.04 -u root bash scripts/wsl-docker-setup.sh <linux-user>
#
# Installs from the official Docker and NVIDIA apt repositories, enables systemd (WSL),
# creates <linux-user> if missing and adds it to the docker group.
set -euo pipefail

user="${1:-}"
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
. /etc/os-release

echo "== apt prerequisites"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ca-certificates curl gnupg rsync >/dev/null

echo "== Docker apt repository"
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list

echo "== NVIDIA Container Toolkit apt repository"
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
    | gpg --dearmor --yes -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
    | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
    > /etc/apt/sources.list.d/nvidia-container-toolkit.list

echo "== install docker-ce, compose plugin, nvidia-container-toolkit"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
    nvidia-container-toolkit >/dev/null
nvidia-ctk runtime configure --runtime=docker >/dev/null

if grep -qi microsoft /proc/version; then
    echo "== WSL: enable systemd so Docker starts with the distro"
    if ! grep -q '^systemd=true' /etc/wsl.conf 2>/dev/null; then
        printf '[boot]\nsystemd=true\n' >> /etc/wsl.conf
        echo "   systemd enabled: run 'wsl --shutdown' in Windows, then reopen Ubuntu"
    fi
fi

if [[ -n "$user" ]]; then
    if ! id "$user" >/dev/null 2>&1; then
        useradd -m -s /bin/bash -G sudo "$user"
        echo "== created user $user (no password yet: set one with 'wsl -u root passwd $user' to use sudo)"
    fi
    usermod -aG docker "$user"
    if grep -qi microsoft /proc/version && ! grep -q '^\[user\]' /etc/wsl.conf; then
        printf '[user]\ndefault=%s\n' "$user" >> /etc/wsl.conf
    fi
fi

if pidof systemd >/dev/null 2>&1 && [[ "$(ps -p 1 -o comm=)" == systemd ]]; then
    systemctl enable --now docker >/dev/null
    systemctl restart docker
else
    service docker start >/dev/null 2>&1 || true
fi

echo "== versions"
docker --version
docker compose version
nvidia-ctk --version | head -1
echo "done. Test the GPU: docker run --rm --gpus all ubuntu nvidia-smi"
