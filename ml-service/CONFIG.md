# ml-service configuration

All settings live in one file, [`config.yaml`](config.yaml). The same file is used on a
developer PC and on the production server; a single switch decides which mode runs.

- [Dev or prod: the mode switch](#dev-or-prod-the-mode-switch)
- [How the file is organised](#how-the-file-is-organised)
- [All options](#all-options): [sources](#sources) · [preview](#preview) · [server](#server) ·
  [handshake](#handshake) · [inference](#inference) · [fall](#fall) · [output](#output)
- [Command-line flags](#command-line-flags) · [Environment variables](#environment-variables)
- [Recipes](#recipes) · [Errors you may see](#errors-you-may-see)

---

## Dev or prod: the mode switch

```yaml
prod_mode: false     # false = dev / prototyping, true = production
```

| | **Dev** (`prod_mode: false`) | **Prod** (`prod_mode: true`) |
|---|---|---|
| For | Prototyping, demos, tuning on a PC | The on-prem GPU server |
| Settings from | the `dev:` section | the `prod:` section |
| Allowed sources | webcam, video file, RTSP camera, stream-hub (tcp) | **IP cameras only**: stream-hub (tcp) and RTSP |
| Preview window | on | off |
| Listens for stream-hub on | `127.0.0.1` (this PC only) | `0.0.0.0` (other machines) |

Prod refuses to start if a webcam or video file is listed, so a prototyping setting can't
end up in production by mistake.

**What decides the mode**, highest priority first:

1. `--prod` or `--dev` on the command line
2. the `ML_PROD_MODE` environment variable (`true`/`false`, `1`/`0`, `yes`/`no`). The
   container sets `ML_PROD_MODE=true`.
3. `prod_mode` in `config.yaml`

The first log line shows the result, e.g. `mode: DEV, sources: webcam:local-webcam`.

## How the file is organised

```yaml
prod_mode: false

dev:                 # only used in dev mode
  sources: [...]
  preview: true
  server: {host: 127.0.0.1}

prod:                # only used in prod mode
  sources: [...]
  preview: false
  server: {host: 0.0.0.0}

# everything below is shared by both modes
server: {port: 9999}
handshake: {...}
inference: {...}
fall: {...}
output: {...}
```

- The `dev:` or `prod:` section is laid **on top of** the shared settings. Any shared
  section can be overridden per mode: `sources`, `preview`, `server`, `handshake`,
  `inference`, `fall`, `output`.
- Sections merge key by key. For example, `prod: inference: {weights: yolo26s-pose.pt}`
  changes only the weights; every other `inference` setting stays shared.
- `sources` is a list, so a mode's list **replaces** the shared one; it is not added to it.
- Relative paths (weights, video files, output folder) are relative to the folder that
  holds `config.yaml`.
- Older files without `dev:`/`prod:` sections, or with a single `source:` instead of
  `sources:`, still load.

---

## All options

### sources

The cameras to watch. Every source becomes a camera with its own person tracking, fall
detection and output records. All sources run at the same time.

| `type` | Video from | Allowed in | Fields |
|---|---|---|---|
| `tcp` | Every camera that stream-hub sends (the production path: gateway-back → stream-hub → ml-service) | dev, prod | — |
| `rtsp` | One IP camera, read directly without the Go services | dev, prod | `url` (required) |
| `webcam` | A camera plugged into this computer | dev | `index` |
| `file` | A recorded video | dev | `path` (required), `loop` |

Fields:

| Field | Applies to | Default | Meaning |
|---|---|---|---|
| `camera_id` | rtsp, webcam, file | `rtsp-<n>`, `webcam-<index>`, or the file name | Camera ID used in every output record. Must be unique |
| `index` | webcam | `0` | Which webcam: `0` = first, `1` = second. If the image is black, try the other one |
| `url` | rtsp | — | e.g. `rtsp://user:password@10.0.0.21:554/stream1`. The password is never written to the log |
| `path` | file | — | Video file, relative to `config.yaml` |
| `loop` | file | `true` | Start the video again when it ends. With `false`, that source stops at the end |
| `tenant_id` | rtsp, webcam, file | `handshake.default_tenant_id` | Tenant written to output records |

Rules:

- At most one `tcp` entry. It already receives every stream-hub camera; those cameras use
  the ID gateway-back gives them.
- `camera_id` values must be unique. A camera that connects with an ID already in use is refused.
- Webcams and RTSP cameras that drop out are retried every 3 seconds. An RTSP connection
  attempt gives up after 5 seconds.
- In prod mode only `tcp` and `rtsp` are allowed.

Example:

```yaml
dev:
  sources:
    - type: webcam
      index: 0
      camera_id: desk-webcam
    - type: tcp
    - type: file
      path: videos/test-fall.mp4
      camera_id: replay-1
```

### preview

| Option | Default | Meaning |
|---|---|---|
| `preview` | `false` | Open a window with the annotated video. Press `q` in the window to quit. Turns itself off on a Linux machine with no display |

### server

Only used when a `tcp` source is listed.

| Option | Default | Meaning |
|---|---|---|
| `server.host` | `127.0.0.1` | Address to listen on. `127.0.0.1` = this computer only; `0.0.0.0` = all network interfaces |
| `server.port` | `9999` | Port stream-hub connects to. Must match `ai_server_addr` in `stream-hub/config.json` |

The port has no authentication, so in production keep it on the internal network.

### handshake

How stream-hub identifies each camera when it connects.

| Option | Default | Meaning |
|---|---|---|
| `handshake.tenant_in_handshake` | `false` | `true` once stream-hub sends the tenant ID before the camera ID. Today it sends only the camera ID |
| `handshake.default_tenant_id` | `tenant_example` | Tenant used when it isn't sent, and for webcam/file/RTSP sources without their own `tenant_id` |

### inference

The person and pose detection model.

| Option | Default | Meaning |
|---|---|---|
| `inference.weights` | `yolo26n-pose.pt` | Model file. Sizes from fastest to most accurate: `yolo26n-pose.pt`, `yolo26s-pose.pt`, `yolo26m-pose.pt`, `yolo26l-pose.pt`, `yolo26x-pose.pt`. Downloads automatically on a PC; baked into the container image |
| `inference.device` | `auto` | `auto` = GPU 0 if CUDA is available, otherwise CPU. Or a GPU number (`0`, `1`), or `cpu`. A GPU number on a machine without CUDA falls back to CPU with a warning |
| `inference.half` | `false` | FP16 on GPU. Can be faster on data-center GPUs, but was slower on an RTX 3060 laptop with the nano model, so measure first. Ignored on CPU |
| `inference.conf` | `0.4` | Minimum confidence for a person detection, 0–1. Lower finds more people but more false detections |
| `inference.imgsz` | `640` | Size the image is resized to for the model. Larger sees small/distant people better but is slower |
| `inference.target_fps` | `10` | Most frames per second analysed, per camera. Lower it to handle more cameras; 5 is still enough to see a fall |
| `inference.tracker` | `bytetrack.yaml` | Tracker that follows each person between frames. Ultralytics ships others (`botsort.yaml`, `ocsort.yaml`, ...), but only `bytetrack.yaml` has been tested with this service |

The startup log shows the device picked, e.g. `model yolo26n-pose.pt ready on GPU 0 (...)`.
`inference_ms` in `model_predictions.jsonl` shows the time per frame, to compare settings.

### fall

Thresholds for the fall rules and incident timing. See *Detection logic in detail* in the
[README](README.md#detection-logic-in-detail) for exactly how they are used.

| Option | Default | Meaning |
|---|---|---|
| `fall.min_keypoint_conf` | `0.3` | Body points (shoulders, hips, ...) below this confidence are ignored |
| `fall.lying_torso_angle_deg` | `60` | Torso angle from vertical that counts fully as lying |
| `fall.falling_torso_angle_deg` | `35` | Minimum torso tilt for the `falling` label |
| `fall.lying_aspect_ratio` | `1.3` | Box width ÷ height that counts fully as lying (wider than tall) |
| `fall.fall_velocity` | `0.6` | Hip drop speed for `falling`, in frame heights per second |
| `fall.confirm_seconds` | `3` | How long someone must stay down before an incident opens |
| `fall.recover_seconds` | `3` | How long someone must stay up before the incident closes as recovered |
| `fall.lost_track_seconds` | `10` | A person not seen for this long is forgotten; an open incident becomes `unresolved` |
| `fall.high_after_seconds` | `60` | Incident severity becomes `high` after this long |
| `fall.critical_after_seconds` | `300` | Incident severity becomes `critical` after this long |

Tune `confirm_seconds` first if you get false alarms (raise it) or late alerts (lower it).

### output

| Option | Default | Meaning |
|---|---|---|
| `output.dir` | `data` | Folder for `model_predictions.jsonl`, `incidents.jsonl` and `snapshots/`. In the container this is the `ml-data` volume |
| `output.prediction_interval_s` | `1.0` | At most one `model_predictions` record per person per this many seconds |

---

## Command-line flags

Flags override the file for one run. Source flags **replace** the mode's source list and can
be repeated or combined.

| Flag | Effect |
|---|---|
| `--prod` / `--dev` | Force a mode |
| `--webcam N` | Add webcam `N` (dev only) |
| `--video PATH` | Add a video file (dev only) |
| `--rtsp URL` | Add an RTSP camera |
| `--tcp` | Add the stream-hub listener |
| `--show` / `--no-show` | Preview window on or off |
| `--config PATH` | Use a different config file |

```powershell
python main.py --webcam 0 --tcp        # a webcam next to the stream-hub cameras
python main.py --prod                  # try the prod settings on your PC
```

## Environment variables

| Variable | Meaning |
|---|---|
| `ML_PROD_MODE` | `true` forces prod mode, `false` forces dev. Overrides `prod_mode` in the file; `--prod`/`--dev` override it. Set to `true` in the container |
| `ML_CONFIG` | Path to the config file, instead of `config.yaml` next to `main.py` |
| `OPENCV_FFMPEG_CAPTURE_OPTIONS` | Advanced RTSP options. Defaults to `rtsp_transport;tcp`, which avoids broken frames on busy networks |

---

## Recipes

**Prototype with your webcam** (the shipped default):

```yaml
prod_mode: false
dev:
  sources:
    - type: webcam
      index: 0
```

**Webcam plus the real cameras from stream-hub**: add `- type: tcp` under `dev: sources:`,
or run `python main.py --webcam 0 --tcp`.

**Test one IP camera without the Go services**:

```yaml
dev:
  sources:
    - type: rtsp
      url: rtsp://user:password@192.168.1.50:554/stream1
      camera_id: hallway
```

**Replay a recorded fall** to tune thresholds: a `file` source with `loop: true`, then
watch `incidents.jsonl` while changing `fall:` values.

**Production**: nothing to change. The container sets `ML_PROD_MODE=true`, which uses the
`prod:` section (stream-hub cameras, no preview, listening on all interfaces).

**Production with a bigger model**:

```yaml
prod:
  inference:
    weights: yolo26s-pose.pt
```

and build the image with the same weights:
`docker build --build-arg YOLO_WEIGHTS=yolo26s-pose.pt .` (or `YOLO_WEIGHTS` in
`deploy/docker-compose.yml`). The build fails if the two don't match.

**Different thresholds per mode**, e.g. faster confirmation while demoing:

```yaml
dev:
  fall:
    confirm_seconds: 2
```

---

## Errors you may see

The service checks the file at startup and stops with `config error: ...` instead of
running with a bad setting.

| Message | Fix |
|---|---|
| `prod_mode only allows IP camera sources ('tcp', 'rtsp'), found: webcam (...)` | Remove the webcam/file from `prod:`, or use dev mode |
| `camera_id must be unique, repeated: [...]` | Give each source its own `camera_id` |
| `only one tcp source is allowed` | Keep a single `- type: tcp` |
| `sources[n] (rtsp) needs a url` / `(file) needs a path` | Add the missing field |
| `sources[n] (...): type must be one of ...` | Use `tcp`, `rtsp`, `webcam` or `file` |
| `unknown keys under dev: [...]` / `under fall: [...]` | Check the spelling against the tables above |
| `sources is empty` | List at least one source |
