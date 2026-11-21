# FallGuard on Azure

**https://fallguard-vision.canadacentral.cloudapp.azure.com**

One Azure VM runs the web app, API, database, video relay and camera gateway. The fall detector
(ml-service) runs on a laptop or the Fanshawe server and connects through an SSH tunnel.

| | |
|---|---|
| VM | `fallguard-vm` in `fallguard-rg` (Canada Central): B2ps_v2, 2 vCPU ARM64, 8 GB, Ubuntu 24.04 |
| Data | 32 GB data disk at `/data`: database, video, certificates, code and `.env`. Kept even if the VM is deleted |
| Firewall | 80/443 and 1936 (phone cameras, RTMPS) open; SSH (22) only from the admin's IP |
| Auto-shutdown | daily at 2 AM Toronto (Eastern time, follows daylight saving; was 11 PM until 2026-11-21) |
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

**Pushing the deploy branch to the VM deploys it automatically** (a git hook rebuilds in the
background, about 2-5 minutes):

```bash
git push azure US_ml_module      # 'azure' = the VM; log on the VM: ~/capstone/deploy.log
```

**How long a deploy takes** (B2ps_v2):

| Change | Time | Notes |
|---|---|---|
| Code only (usual) | **1-2 min** | Measured 2026-11-21: frontend, API, stream-hub and gateway rebuilt in about 1 min |
| New dependencies (`go.mod`, `package-lock.json`) | about 3-5 min (estimate) | Packages are downloaded again |
| From scratch (new VM) | about 10 min (estimate) | Every image is built |

Only the services that changed restart, for about 10-30 seconds (the app may show "can't reach
the backend" briefly). Sign-ins, data and video are kept.

- The deploy branch is in `/data/repo.git/deploy-branch` on the VM (`US_ml_module` now, `main` later).
- Rebuild by hand on the VM: `bash ~/capstone/deploy/azure/deploy.sh`.
- First-time VM setup: `sudo bash deploy/azure/vm_setup.sh`, then install the hook:
  `cp deploy/azure/post-receive /data/repo.git/hooks/ && chmod +x /data/repo.git/hooks/post-receive`.
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

## Phone cameras

In the app: **Cameras → Add phone camera** → scan the QR code with Larix Broadcaster → start
streaming. Works from any network; no laptop. How it works: the phone sends RTMPS to the relay
on port 1936 (Let's Encrypt certificate from Caddy); the relay asks the API for each
connection; the gateway reads the phone from the relay inside the VM.

## Cameras on another network (laptop forwarding)

For a camera that can't send by itself (an IP camera, or a phone RTSP server app at home):

1. On a computer on the camera's network (WSL), leave this running (login in the address if
   the camera needs one): `bash deploy/azure/send-camera.sh 'rtsp://user:pass@10.0.0.200:8554/' phone1`
2. In the app, add the camera as `rtsp://test-camera:8554/phone1`, with no username or password.

Video flows only while that computer is on and the script runs. It needs the VM SSH key.

## To do

- **Schedule:** start/stop windows with Azure Automation (e.g. weekdays 8 AM–8 PM ≈ $28/month).
- **Auto-deploy from GitHub:** rebuild on every push to `main` on GitHub, from anyone's machine (GitHub Actions).

## Backup

Snapshot the data disk before risky changes:

```powershell
$disk = az vm show -g fallguard-rg -n fallguard-vm --query "storageProfile.dataDisks[0].name" -o tsv
az snapshot create -g fallguard-rg -n "fallguard-data-$(Get-Date -Format yyyyMMdd)" --source $disk --sku Standard_LRS
```
