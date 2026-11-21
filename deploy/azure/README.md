# FallGuard on Azure

**https://fallguard-vision.canadacentral.cloudapp.azure.com**

One Azure VM runs the web app, API, database, video relay and camera gateway. The fall detector
(ml-service) runs on a laptop or the Fanshawe server and connects through an SSH tunnel.

| | |
|---|---|
| VM | `fallguard-vm` in `fallguard-rg` (Canada Central): B2ps_v2, 2 vCPU ARM64, 8 GB, Ubuntu 24.04 |
| Data | 32 GB data disk at `/data`: database, video, certificates, code and `.env`. Kept even if the VM is deleted |
| Firewall | 80/443 open; SSH (22) only from the admin's IP |
| Auto-shutdown | daily at 11 PM Toronto |
| Branch | `US_ml_module` while testing; `main` later |
| Credit | Azure for Students, $100, until Nov 2027 |

## Cost

- VM: $0.074/hour while running, $0 while stopped.
- Disks + IP: about $9/month, always.
- About 80 hours a month ≈ $15/month.

## Start and stop

```powershell
az vm start      -g fallguard-rg -n fallguard-vm   # app is up in 1-2 min
az vm deallocate -g fallguard-rg -n fallguard-vm   # end of session
```

- **Stop, don't delete.** Stopped = no compute cost, everything kept. Deleting saves nothing more.
- Use the portal's **Stop** or `az vm deallocate`. Shutting down inside Linux keeps billing.
- `az group delete -n fallguard-rg` only when the project is over: it deletes the data too.

## Deploy and update

Push the code to the VM, then on the VM:

```bash
cd ~/capstone && git pull && docker compose -f docker-compose.yml -f docker-compose.azure.yml up -d --build \
    db partitions api stream-hub gateway-back frontend caddy
```

- First-time VM setup: `sudo bash deploy/azure/vm_setup.sh`.
- `~/capstone/.env` (not in git): as `.env.example`, plus `PROD_MODE=true`, `SITE_ADDRESS` and
  `APP_URL` = the web address, `COOKIE_SECURE=true`, SMTP settings, `APP_SECRET`.

SSH: `ssh -i ~/.ssh/fallguard_azure fallguard@fallguard-vision.canadacentral.cloudapp.azure.com`

## Connect the fall detector

From the machine running ml-service (laptop or Fanshawe server):

```bash
ssh -N -i ~/.ssh/fallguard_tunnel -R 0.0.0.0:9999:localhost:9999 -L 15432:127.0.0.1:5433 \
    tunnel@fallguard-vision.canadacentral.cloudapp.azure.com
```

ml-service then writes to `postgresql://ml_service:<password>@127.0.0.1:15432/fallguard`.

To do: create the `tunnel` user (port forwarding only) and check outbound SSH from the Fanshawe server.

## To do

- **Cameras:** a video relay on the VM that phones send to (e.g. Larix Broadcaster), so cameras
  work from any network.
- **Schedule:** start/stop windows with Azure Automation (e.g. weekdays 8 AM–8 PM ≈ $28/month).
- **Auto-deploy:** rebuild the VM on every push to `main` (GitHub Actions).

## Backup

Snapshot the data disk before risky changes:

```powershell
$disk = az vm show -g fallguard-rg -n fallguard-vm --query "storageProfile.dataDisks[0].name" -o tsv
az snapshot create -g fallguard-rg -n "fallguard-data-$(Get-Date -Format yyyyMMdd)" --source $disk --sku Standard_LRS
```
