# syntax=docker/dockerfile:1
# ml-service for a Linux server with an NVIDIA GPU. Runs config.yaml in prod mode.
#
# Host requirements: NVIDIA driver 580+ (for CUDA 13.0) and the NVIDIA Container Toolkit.
# The PyTorch wheel bundles the CUDA runtime, so a plain Python base image is enough.
#
#   docker build -f setup_and_tools/docker_server/Dockerfile -t ml-service .    (from ml-service/)
#   docker run --gpus all -p 9999:9999 -v ml-data:/app/data ml-service

ARG PYTHON_VERSION=3.15

# ---------- build: compile packages that have no Python 3.15 wheels yet ----------
FROM python:${PYTHON_VERSION}-slim-bookworm AS build

RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential libyaml-dev \
 && rm -rf /var/lib/apt/lists/*

RUN python -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH

# CUDA build by default; the root docker-compose.cpu.yml passes the CPU index for machines
# without an NVIDIA GPU (Macs, laptops).
ARG TORCH_INDEX=https://download.pytorch.org/whl/cu130
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir torch torchvision --index-url ${TORCH_INDEX}

COPY requirements.txt .
# PyYAML and lap build from source here (with the compiler), so the image uses the
# real packages and app/detection/lap_compat/lap.py stays unused.
RUN pip install --no-cache-dir -r requirements.txt "lap>=0.5.12"

# ---------- runtime ----------
FROM python:${PYTHON_VERSION}-slim-bookworm

# libgl1 / libglib2.0-0: needed by opencv-python. libyaml-0-2: PyYAML's C extension.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 libyaml-0-2 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 1000 app \
 && mkdir -p /app/data /app/.ultralytics \
 && chown -R app:app /app

COPY --from=build /opt/venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    YOLO_CONFIG_DIR=/app/.ultralytics \
    ML_PROD_MODE=true

WORKDIR /app
COPY --chown=app:app . .
USER app

# Bake the weights into the image so the server needs no internet access at runtime.
# A file in models/ (e.g. a fine-tuned model) is copied in; a standard name like
# yolo26s-pose.pt is downloaded into models/ here. Change with
# --build-arg YOLO_WEIGHTS=..., and set models/<the same name> under prod: inference: weights.
ARG YOLO_WEIGHTS=yolo26n-pose-finetuned-mcfDataset-111026.pt
RUN mkdir -p /app/models && cd /app/models && python - <<EOF
import os
import sys

import numpy as np
from ultralytics import YOLO, settings

sys.path.insert(0, "/app")
from app import config

# The real database URL is only given at runtime; the check below just needs one present.
os.environ.setdefault("ML_DATABASE_URL", "postgresql://build-check@localhost/none")

settings.update({"sync": False})  # no usage analytics from an on-prem install
model = YOLO("${YOLO_WEIGHTS}")  # in /app/models: uses the copied file, or downloads it here
# Run the tracker once (on CPU, no GPU at build time). Fails the build if anything is
# missing, instead of Ultralytics trying to pip-install it at runtime.
model.track(np.zeros((640, 640, 3), dtype=np.uint8), device="cpu", verbose=False)

# Fail the build if config.yaml is not valid in prod mode (e.g. a webcam under prod:),
# or if it expects different weights than the ones baked in.
cfg = config.load("/app/config.yaml", prod_mode=True)
assert cfg.inference.weights == "/app/models/${YOLO_WEIGHTS}", (
    f"config.yaml prod mode uses {cfg.inference.weights}, image has ${YOLO_WEIGHTS}")
print("image check OK:", "${YOLO_WEIGHTS}", [s.type for s in cfg.sources])
EOF

VOLUME /app/data
# 9999: stream-hub's video + results connection. There is no HTTP port any more: the live
# viewer is gone (stream-hub now records clips and stores snapshots; the backend reads
# this service's status from the database's ml_status table).
EXPOSE 9999
CMD ["python", "main.py"]