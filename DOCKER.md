# Running the platform in Docker

```
camera (RTSP) ─► gateway-back :8080 ─► stream-hub :8090 ─► ml-service :9999 ─► db :5432
                                           └─► browsers over WebSocket :9000
```

| Service | Folder | Ports on the host | Notes |
|---|---|---|---|
| `db`, `partitions` | `backend-module/` | `127.0.0.1:5432` | PostgreSQL 17 + pgvector |
| `ml-service` | `ml-service/deploy/` | `9999` | Needs an NVIDIA GPU; prod mode (IP cameras only) |
| `stream-hub` | `stream-hub/` | `9000` (HTTP/WS), `8090` (gateways) | Forwards every camera to `ml-service:9999` |
| `gateway-back` | `gateway-back/` | `8080` (web UI + API) | Cameras and settings kept in the `gateway-data` volume |
| `test-camera` (optional) | root | `8554` | Plays `test-media/test.mp4` as `rtsp://test-camera:8554/test` |

The root [`docker-compose.yml`](docker-compose.yml) runs everything; each folder's own
compose file runs that module alone. All of them declare the same fixed-name Docker network
`fallguard` (whichever starts first creates it, the others join), so services reach each
other by name (`db`, `ml-service`, `stream-hub`, `gateway-back`) and can start in any order.

## 1. One-time machine setup

**Linux server:** Docker Engine, the NVIDIA driver 580+ and the NVIDIA Container Toolkit;
`sudo bash scripts/wsl-docker-setup.sh <user>` installs the Docker parts on Ubuntu.

**Windows PC (WSL 2):**

1. `wsl --install -d Ubuntu-24.04 --no-launch` (asks for admin), then **reboot**.
2. After the reboot, run the same command again if `wsl -l -v` shows no distribution:
   the first run only enables WSL itself.
3. From the repo folder in PowerShell:
   `wsl -d Ubuntu-24.04 -u root --cd "$PWD" -- bash scripts/wsl-docker-setup.sh <your-linux-user>`.
   It installs Docker Engine, the Compose plugin and the NVIDIA Container Toolkit, and makes
   `<your-linux-user>` the default WSL user.
4. `wsl --terminate Ubuntu-24.04` so the default user takes effect.
5. Check the GPU: `wsl -d Ubuntu-24.04 -- docker run --rm --gpus all ubuntu:24.04 nvidia-smi`.
   The Windows NVIDIA driver provides the GPU to WSL; don't install a Linux driver.
6. Optional: `wsl -u root passwd <your-linux-user>` to be able to use `sudo`.

Build from a copy inside Ubuntu's own disk, not from `/mnt/d` (the Windows drive is much
slower for Docker, and OneDrive can lock files mid-build):

```bash
rsync -a --delete --exclude .git --exclude .venv --exclude node_modules --exclude __pycache__ \
    --exclude ml-service/data --exclude '*.pt' \
    "/mnt/d/<path to>/capstone-xcelerate-aiml-computer-vision/" ~/fallguard/
chmod 600 ~/fallguard/backend-module/.env ~/fallguard/ml-service/deploy/.env
cd ~/fallguard
```

Rerun the `rsync` after editing code on Windows, then rebuild the changed service. (Or
clone the repo inside Ubuntu and work there directly.)

## 2. Secrets

```bash
cp backend-module/.env.example backend-module/.env           # POSTGRES_PASSWORD, ML_SERVICE_PASSWORD
cp ml-service/deploy/.env.example ml-service/deploy/.env     # ML_DATABASE_URL with the same ML_SERVICE_PASSWORD
```

Both are git-ignored. Use letters and digits only, or URL-encode the password in `ML_DATABASE_URL`.

## 3. Run

```bash
docker compose up -d --build            # first build ~10–20 min (ml-service pulls PyTorch + CUDA)
docker compose ps                       # all "running"; db and stream-hub "healthy"
```

What to look for:

| Command | Expected |
|---|---|
| `docker compose logs db` | `02-seed: loading`, `03-roles: creating role ml_service`, `ready to accept connections` |
| `docker compose logs partitions` | `partitions ensured for this month + 2 ahead` |
| `docker compose logs ml-service` | `model yolo26n-pose.pt ready on GPU 0 (...)`, `database connected`, `listening for stream-hub on 0.0.0.0:9999` |
| `docker compose logs stream-hub` | `ai=ml-service:9999`, `Ingestion TCP server listening on :8090` |
| `docker compose logs gateway-back` | `created config.json (cloud_address=stream-hub:8090 ...)`, `Gateway active` |
| http://localhost:8080 | The gateway UI |

## 4. Test the whole chain

```bash
# A camera: test-media/test.mp4 on a loop (put a clip with people in it there)
docker compose --profile test-camera up -d test-camera

# Register it in the gateway (or use the UI at http://localhost:8080)
curl -X POST http://localhost:8080/gateway/actions/cameras \
     -H 'Content-Type: application/json' \
     -d '{"name":"test camera","rtsp_url":"rtsp://test-camera:8554/test"}'

docker compose logs -f stream-hub ml-service   # camera connects at the hub, then at ml-service

# Results in the database
docker compose exec db psql -U fallguard_admin fallguard -c \
  "SELECT camera_id, label, count(*) FROM model_predictions GROUP BY 1,2;"
```

A real IP camera works the same way: add its `rtsp://user:password@<ip>:554/...` URL
in the gateway. It must stream **H.264**.

## Day-to-day

| Task | Command |
|---|---|
| Rebuild one service after a code change | `docker compose up -d --build ml-service` |
| Stop everything, keep data | `docker compose down` |
| Reset everything (database, cameras, results) | `docker compose down -v` |
| Only the database | `cd backend-module && docker compose up -d` |

Start order doesn't matter: the gateway, stream hub and ML service all retry their
connections until the next service is up.
