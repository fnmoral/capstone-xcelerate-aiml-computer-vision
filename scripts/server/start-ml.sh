#!/bin/sh
# (Re)starts ml-service on the course server in prod mode (stream-hub cameras + database),
# for docker-compose.remote-ml.yml. Runs on the server: sh fallguard/start-ml.sh
#
# Needs ~/fallguard/ml-service (the code + .venv) and ~/fallguard/ml.env with
#   ML_DATABASE_URL=postgresql://ml_service:<password>@127.0.0.1:15432/fallguard
# (15432 = the reverse tunnel to the database on the laptop).
set -eu
cd ~/fallguard/ml-service

pkill -f "python main.py" || true
sleep 1

# Same settings as config.yaml, but listen inside this container only: the ports are
# reached through the SSH tunnel, and other containers on the server can't see them.
sed -E 's/host: 0\.0\.0\.0/host: 127.0.0.1/' config.yaml > config.server.yaml

set -a
. ~/fallguard/ml.env
set +a
export ML_CONFIG="$PWD/config.server.yaml" ML_PROD_MODE=true YOLO_OFFLINE=true

setsid nohup .venv/bin/python main.py > ml.log 2>&1 < /dev/null &
echo "ml-service started (log: ~/fallguard/ml-service/ml.log)"
