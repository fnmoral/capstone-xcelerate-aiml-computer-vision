# FallGuard on Azure

**https://fallguard-vision.canadacentral.cloudapp.azure.com**

One Azure VM runs the web app, API, database, video relay and camera gateway. The fall detector
(ml-service) runs on a laptop or the Fanshawe server and connects through an SSH tunnel.

| | |
|---|---|
| VM | `fallguard-vm` in `fallguard-rg` (Canada Central): B2ps_v2, 2 vCPU ARM64, 8 GB, Ubuntu 24.04 |
| Data | 32 GB data disk at `/data`: database, video, certificates, code and `.env`. Kept even if the VM is deleted |
| Firewall | 80/443, 1936 (phone cameras, RTMPS) and 1935 (phone cameras, plain RTMP for Streamza; rule `allow-rtmp-phones-temp`) open; SSH (22) only from the admin's IP |
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

ml-service runs on the Fanshawe server (or a laptop) and connects out to the VM. On the server,
from campus:

```bash
sh fallguard/tunnel-azure.sh     # stays connected, reconnects; log ~/fallguard/tunnel.log
sh fallguard/start-ml.sh         # ml-service; log ~/fallguard/ml-service/ml.log
```

- The VM's `tunnel` user can only forward ports (no shell); each machine has its own key.
- The VM firewall allows SSH only from listed IPs (rule `ssh-from-fanshawe`: the Fanshawe
  server and the campus laptop). A new address needs adding there.
- Check: `/api/health` shows ml-service OK.

## On-site gateway (cameras on a local network)

The product design: the gateway runs next to the cameras and only the video goes to Azure.

1. On the computer with the cameras: `docker compose -f deploy/onsite-gateway/docker-compose.yml up -d --build`
   (key `~/.ssh/fallguard_gateway`, allowed on the VM's `tunnel` user for port 18080).
2. In the app: **Settings → Gateways**. It signs up as "On-site gateway": rename it to the place
   (e.g. "Office server"). Automatic uses it while it's online, else the Cloud gateway (phone
   cameras only). One gateway at a time; admins can pick one.
3. Laptop webcam: `publish_webcam.py --index 1 --url rtsp://127.0.0.1:8554/webcam`, then
   **Cameras → Add camera** `rtsp://test-camera:8554/webcam`. IP cameras: their own address.

- A second on-site gateway: `GATEWAY_TUNNEL_PORT=18081` and its own `GATEWAY_NAME_ID`, and its
  key allowed for that port on the VM.
- Campus addresses change: if the tunnel times out, the laptop's public IP is no longer in the
  firewall rule `ssh-from-fanshawe`. Dead tunnels free their port on the VM within ~90 s.

## Phone cameras (temporary, for demos)

May be removed once cameras connect through an on-site gateway. In the app: **Cameras → Add phone camera** → in **Streamza** (Custom RTMP) paste the server and
stream key (a QR code each) → Go Live. Works from any network; no laptop. How it works: the
phone sends RTMP to the relay on port 1935 (Streamza can't do RTMPS) or RTMPS on 1936 (Larix,
OBS; Let's Encrypt certificate from Caddy); the relay asks the API for each connection (same
per-phone password on both); the gateway reads the phone from the relay inside the VM.

## Cameras on another network (laptop forwarding)

For a camera that can't send by itself (an IP camera, or a phone RTSP server app at home):

1. On a computer on the camera's network (WSL), leave this running (login in the address if
   the camera needs one): `bash deploy/azure/send-camera.sh 'rtsp://user:pass@10.0.0.200:8554/' phone1`
2. In the app, add the camera as `rtsp://test-camera:8554/phone1`, with no username or password.

Video flows only while that computer is on and the script runs. It needs the VM SSH key.

## To do

- **Gateway registration key:** gateways sign up without a password; only from the server or
  its tunnels (not through the website). Add a per-gateway key created by an admin.
- **Schedule:** start/stop windows with Azure Automation (e.g. weekdays 8 AM–8 PM ≈ $28/month).
- **Auto-deploy from GitHub:** rebuild on every push to `main` on GitHub, from anyone's machine (GitHub Actions).

## Backup

Snapshot the data disk before risky changes:

```powershell
$disk = az vm show -g fallguard-rg -n fallguard-vm --query "storageProfile.dataDisks[0].name" -o tsv
az snapshot create -g fallguard-rg -n "fallguard-data-$(Get-Date -Format yyyyMMdd)" --source $disk --sku Standard_LRS
```
