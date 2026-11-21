# FallGuard on Azure (demo deployment)

The web app, API, database, video relay and camera gateway run on one small Azure VM. The fall
detector (ml-service) does **not**: it runs on a laptop GPU or the Fanshawe server and connects
to the VM through an SSH tunnel.

| | |
|---|---|
| Web address | **https://fallguard-vision.canadacentral.cloudapp.azure.com** |
| Subscription | Azure for Students ($100 credit, until Nov 2027) |
| Resource group | `fallguard-rg` (Canada Central) |
| VM | `fallguard-vm`, **Standard_B2ps_v2** (2 vCPU ARM64, 8 GB), Ubuntu 24.04 |
| Disks | OS 32 GB Standard SSD (deleted with the VM); **data 32 GB Standard SSD at `/data`** (kept even if the VM is deleted) |
| What lives on the data disk | Docker's storage: the database (accounts, incidents, logs, reports), video clips and snapshots, certificates, built images |
| Firewall (NSG `fallguard-nsg`) | 80 / 443 open (the app, HTTPS); 22 (SSH) only from the admin's IP |
| Auto-shutdown | every night 04:00 UTC (11 PM Toronto, standard time) |
| SSH | `ssh -i ~/.ssh/fallguard_azure fallguard@fallguard-vision.canadacentral.cloudapp.azure.com` |

## Costs (Canada Central prices, Nov 2026)

| Item | Cost |
|---|---|
| VM B2ps_v2 | $0.0736 per hour **while running**; nothing while stopped (deallocated) |
| 2 × Standard SSD 32 GB | about $5.30 per month, always |
| Static public IP | about $3.65 per month, always |

About 80 demo hours a month comes to roughly $15 a month, so the credit lasts well over six months.

## Start and stop (every demo session)

Always **stop** with the portal's **Stop** button or the command below. That *deallocates* the
VM: compute billing stops, and all disks, the address and the data stay. Shutting down from
inside Linux does **not** stop billing.

```powershell
az vm start      -g fallguard-rg -n fallguard-vm    # about 1-2 minutes; the app starts by itself
az vm deallocate -g fallguard-rg -n fallguard-vm    # at the end of the session
az vm show -d    -g fallguard-rg -n fallguard-vm --query powerState -o tsv
```

**Stop or delete?** Stop. A stopped VM costs nothing for compute; deleting it saves nothing more
(the data disk and address are kept and billed either way) and means rebuilding next time. Only
delete everything (`az group delete -n fallguard-rg`) when the project is over: that also
deletes the data disk.

## First deployment (done 2026-11-20)

1. VM setup: `deploy/azure/vm_setup.sh` (Docker with its storage on `/data`, swap, automatic
   security updates). Run once with `sudo bash`.
2. Code: the repo is pushed from a laptop to a bare repository on the VM (no GitHub
   credentials on the VM):
   ```powershell
   git remote add azure fallguard@fallguard-vision.canadacentral.cloudapp.azure.com:/data/repo.git
   git push azure US_ml_module
   ```
   On the VM, `~/capstone` is a checkout of that repository.
3. `~/capstone/.env`: the same settings as `.env.example`, with `PROD_MODE=true`, no
   `COMPOSE_PROFILES`, `SITE_ADDRESS` and `APP_URL` set to the web address, `COOKIE_SECURE=true`,
   the Gmail SMTP settings and an `APP_SECRET`. It is never in git.
4. Start:
   ```bash
   cd ~/capstone
   docker compose -f docker-compose.yml -f docker-compose.azure.yml up -d --build \
       db partitions api stream-hub gateway-back frontend caddy
   ```

## Update to a new version

```powershell
git push azure US_ml_module      # from the laptop
```
```bash
cd ~/capstone && git pull && docker compose -f docker-compose.yml -f docker-compose.azure.yml up -d --build \
    db partitions api stream-hub gateway-back frontend caddy
```

## Connect the fall detector (ml-service)

stream-hub on the VM dials ml-service on port 9999, and ml-service writes to the database, so the
machine running ml-service opens one SSH connection **out** to the VM that carries both:

```bash
# on the laptop (WSL) or the Fanshawe server, with ml-service listening on localhost:9999
ssh -N -i ~/.ssh/fallguard_tunnel \
    -R 0.0.0.0:9999:localhost:9999 \
    -L 15432:127.0.0.1:5433 \
    tunnel@fallguard-vision.canadacentral.cloudapp.azure.com
# ml-service then uses ML_DATABASE_URL=postgresql://ml_service:<password>@127.0.0.1:15432/fallguard
```

To do: the `tunnel` user on the VM (port forwarding only, no shell), the detector's key, and
whether the Fanshawe server allows outbound SSH (to check). Cameras: see "Cameras" below.

## Cameras

To decide: phones with an RTSP app may not be on the laptop's network. The proposal is a video
relay on the VM that phones *send* to (with an app that can publish, e.g. Larix Broadcaster),
read by the gateway on the VM, so cameras work from any network.

## Backups

The data disk survives a VM deletion. For extra safety, take a disk snapshot before risky changes:

```powershell
$disk = az vm show -g fallguard-rg -n fallguard-vm --query "storageProfile.dataDisks[0].name" -o tsv
az snapshot create -g fallguard-rg -n "fallguard-data-$(Get-Date -Format yyyyMMdd)" --source $disk --sku Standard_LRS
```
