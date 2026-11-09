# ML Service — Fall Detection

Watches camera video and notices when someone falls and stays down.

- **[Part 1 — What it does](#part-1--what-it-does)**: for everyone, no technical background needed
- **[Part 2 — Technical reference](#part-2--technical-reference)**: setup, running it, then
  architecture, detection logic and deployment

---

# Part 1 — What it does

## In short

The service looks at live camera video, finds every person in view, and keeps checking
whether each one is **standing**, **falling** or **lying on the floor**. If someone falls and
stays down for a few seconds, it records a **fall incident** with the time, how serious it
is, and a photo of the moment. When the person gets back up, it records that they recovered
and how long they were down.

## What it can watch

| Camera | When it's used |
|---|---|
| **IP cameras** (security cameras on the network) | The real setup. The cameras send video through the project's gateway and stream-hub |
| **A webcam on a laptop or PC** | Trying things out and demos |
| **A recorded video** | Replaying a fall to test the system |

It can watch several cameras at the same time. A webcam is handled exactly like an IP
camera, so what you see in a demo is what happens with real cameras — except that a webcam
or file has no stream-hub behind it, so its clips and live overlay aren't available (see
[Outputs](#6-outputs)).

**Cameras that overlap.** When two or more cameras look at the same room, they can be
grouped into a *zone*. A fall seen by several cameras of a zone is then recorded **once**,
with every camera that saw it and a photo from each, instead of raising one alert per camera.

## What it recognises

For every person, several times a second, it decides one of three states:

| State | What it means | Colour on screen |
|---|---|---|
| **Upright** | Standing, walking or sitting: everything normal | 🟢 green |
| **Falling** | Going down quickly right now | 🟠 orange |
| **Lying** | On the floor | 🔴 red |

It works this out from the position of the body: it finds points like the shoulders, hips,
knees and head, then looks at how tilted the body is, whether it's wider than it is tall,
and how fast the hips are dropping. Each person in view is followed separately, so two
people in the same room each get their own state.

## When does it decide someone has fallen?

A single glance is not enough, because people bend down, crouch and sit all the time. So the
service waits to be sure:

1. **Someone goes down and is still lying after 3 seconds** → a **fall incident starts**.
   A photo is saved, and the start time is set to the moment they began to fall.
2. **They stay down longer** → the incident gets **more serious**:
   *medium* at first, *high* after 1 minute, *critical* after 5 minutes.
3. **They get up and stay up for 3 seconds** → the incident is marked **recovered**, with
   how long they were on the floor.
4. **They disappear from view while still down** (for example, the camera loses sight of
   them on the floor, or the camera goes offline) → the incident is marked **unresolved**,
   meaning someone should check.

Things that do **not** count as a fall: bending over to pick something up, crouching,
sitting down quickly, or a single frame where the camera briefly misreads someone.

All the timings above can be changed in the settings.

## What happens after a fall (today)

- The incident is **saved to the project database**: when it started, how serious it is,
  how sure the system was, which cameras saw it, and when the person recovered.
- An **alert** is created for it in the database, ready for the web app to show and for
  staff to acknowledge.
- A **photo** of the moment is saved from each camera that saw it. For a camera that comes
  through stream-hub (the real setup), this service only *takes* the photo; stream-hub is
  what actually stores it. For a webcam, RTSP or video-file source used while prototyping,
  this service stores it itself, next to the other local files below.
- A **video clip** is saved from each camera that saw it, like a car dashcam: from 15
  seconds before the fall until 10 seconds after the person is back up (or out of view).
  This is entirely stream-hub's job: it keeps a short loop of each camera's video and turns
  it into the clip, so it only happens for cameras that come through it.
- Model predictions and incident records are also kept in local files on this machine, so
  nothing is lost if the database is unreachable for a while; the service keeps detecting
  and catches up when the database is back. (Clips and stream-hub-stored photos don't have
  this fallback: they only exist where stream-hub saved them.)

## Try it yourself

1. Open `ml-service` in VS Code and run `main.py` (it uses your webcam by default).
2. Wait for the message `model ... ready`, about 5–15 seconds.
3. Stand in view: you should see a **green** box with your number, e.g. `#1 upright`.
4. Lie down on the floor: the box turns **red**, and after 3 seconds the log shows
   `incident_started` and a photo appears in `data/snapshots/` (this is the webcam path;
   see the note above).
5. Stand up: 3 seconds later the log shows `incident_recovered`.
6. Press `q` in the video window to stop.

## Not done yet

- **No notifications.** Alerts are stored in the database, but nothing sends an email or
  message yet.
- **Rules, not a trained model.** The decision is made by hand-tuned rules, so expect some
  false alarms or misses until they are tuned on real footage. A trained model is planned.
- **Overlapping cameras need setting up.** Cameras only merge their alerts once they are
  grouped into a zone. And if two different people fall at almost the same moment, each
  seen by a different camera of the same zone, they are recorded as one fall.
- **No authentication on the video path.** stream-hub's connections (the one this service
  uses, and the one the frontend uses) have no login; see [Known gaps](#known-gaps).

---

# Part 2 — Technical reference

Speaks a length-prefixed TCP protocol with stream-hub, documented in full in
`ingest/protocol.py` and `ingest/results.py`, on port `9999` (`ai_server_addr` in
`stream-hub/config.json`). Runs on a Windows PC for prototyping and in a Linux container on
the GPU server for production (see [Deployment](#deployment-linux-server-container)).

## Setup

Pick your OS below, then continue to [Running](#running-dev-and-prod-mode).

### Windows (PowerShell, Python 3.15, NVIDIA GPU)

```powershell
cd ml-service
py -V:3.15 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu130
$env:PYYAML_FORCE_LIBYAML = "0"
pip install -r requirements.txt
```

Python 3.15 is new, so a few packages need workarounds until they publish 3.15 wheels:

- **PyTorch** is only on the PyTorch CUDA index, not PyPI. The CUDA 13.0 build needs NVIDIA driver 580+.
- **PyYAML** has no 3.15 wheel; `PYYAML_FORCE_LIBYAML=0` builds the pure-Python version
  instead of failing for lack of a C++ compiler.
- **lap**, which Ultralytics' ByteTrack imports, cannot be built without a C++ compiler.
  `compat/lap.py` stands in for it using Ultralytics' own NumPy solver and is only used
  when the real package is missing. Delete `compat/` once `pip install lap` works.

The YOLO26 weights (`yolo26n-pose.pt`) download automatically on first run.

### Linux / macOS (bash)

```bash
cd ml-service
python3 -m venv .venv
source .venv/bin/activate
# NVIDIA GPU (Linux only): pick the CUDA build that matches your driver
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu130
# No NVIDIA GPU (macOS, or a Linux machine without one): CPU build instead
#   pip install torch torchvision
pip install -r requirements.txt
```

This runs on plain Python 3.12+ without any workaround: PyYAML and `lap` both ship
prebuilt wheels there, so `compat/lap.py` stays unused. The Windows section above (and its
`PYYAML_FORCE_LIBYAML=0` step) is only for Python 3.15, which doesn't have those wheels yet;
on Linux/macOS the equivalent is the same environment variable, set the bash way:

```bash
PYYAML_FORCE_LIBYAML=0 pip install -r requirements.txt   # only needed on Python 3.15
```

The YOLO26 weights (`yolo26n-pose.pt`) download automatically on first run.

**If the preview window (`cv2.imshow`) fails with a `libGL` error**, install the same
system packages the Docker image uses: `sudo apt install libgl1 libglib2.0-0`
(Debian/Ubuntu; other distributions have equivalent packages). You don't need this at all
if you only run with `--no-show`.

**On WSL (Windows Subsystem for Linux)**, a PC's webcam isn't visible by default — `/dev/video*`
is simply empty, even though Windows sees the camera fine — so `--webcam` won't find one.
Either pass the camera through with `usbipd-win` (it then stops being usable from Windows
while attached), or skip the webcam path and use `--video some-recording.mp4` or
`tools/send_video.py --source some-recording.mp4` instead, which need no camera at all and
exercise the same detection code (see [Try it yourself](#try-it-yourself) above and
[Command-line flags](CONFIG.md#command-line-flags)).

## Running: dev and prod mode

`config.yaml` has one switch, `prod_mode`, which picks its `dev:` or `prod:` section.
**Every option is documented in [CONFIG.md](CONFIG.md).**

| | Dev (`prod_mode: false`, the default) | Prod (`prod_mode: true`) |
|---|---|---|
| Sources | webcam, video file, RTSP camera, stream-hub | IP cameras only: stream-hub (`tcp`) and `rtsp` |
| Preview window | on | off |
| Listens on | `127.0.0.1` | `0.0.0.0` |

`--prod` / `--dev` or the `ML_PROD_MODE` environment variable override the file; the
container sets `ML_PROD_MODE=true`. Prod refuses to start if a webcam or video file is
listed. The first log line shows the mode and sources.

Source types (see [CONFIG.md → sources](CONFIG.md#sources) for every field):

| `type` | Video from | Allowed in |
|---|---|---|
| `tcp` | every camera stream-hub sends, port 9999 | dev, prod |
| `rtsp` | an IP camera, read directly | dev, prod |
| `webcam` | a camera plugged into this PC | dev |
| `file` | a local video | dev |

Every source becomes its own camera, all at the same time. Webcams and RTSP cameras that
drop out are retried every few seconds, like stream-hub cameras.

With `preview: true` a window shows the annotated video, so the VS Code Run button is enough.
Command-line flags replace the source list for a quick test, and can be combined or repeated:

```bash
python main.py                                      # whatever config.yaml says
python main.py --prod                               # try the prod settings
python main.py --webcam 0 --tcp                     # a webcam next to the stream-hub cameras
python main.py --rtsp rtsp://user:pw@10.0.0.21/s1   # an IP camera
python main.py --video fall.mp4                     # a video file
python main.py --no-show                            # no preview window
```

A mode flag (`--prod`/`--dev`) and a source flag can't fight: `--prod` with
`--webcam`/`--video` is rejected, since production only watches IP cameras.

Wait for `model ... ready` in the log (about 5–15 s), then step into view.
Results go to `data/` (git-ignored), and, for stream-hub cameras, to stream-hub itself
(live detections, clips, snapshots — see [Outputs](#6-outputs)). Press `q` in the preview
window to quit.

To test the TCP path without the Go services, `tools/send_video.py --source 0
--tenant-id <slug>` plays the part of stream-hub (pass `--tenant-id` whenever
`handshake.tenant_in_handshake` is on, which the shipped config always has).

## Architecture

```
stream-hub (H.264/H.265 + PTS) ──┐
webcam / RTSP / file (OpenCV) ───┴─► decode (PyAV, grouped by PTS) ─► newest frame
     ─► YOLO26-pose + ByteTrack (≤ 10 fps) ─► pose features ─► fall rules
     ─► incident state machine (one per camera) ─┐
                     other cameras' state machines ┴─► zone merge ─► reporting.py ─┬─► sinks (database, data/*.jsonl)
                                                                                    └─► stream-hub, on the camera's
                                                                                        connection: live detections,
                                                                                        incident events, recording
                                                                                        start/stop, snapshots
```

Every source becomes a camera with its own tracker, fall state and outputs. A webcam goes
through exactly the same detection steps as an IP camera, so prototyping results carry
over — the difference is only in what leaves the service (see the architecture diagram and
[Outputs](#6-outputs)): a stream-hub camera has somewhere to send results back to; a webcam,
RTSP or file source does not, so it only writes to the sinks.

`main.py` is now a thin entry point; everything it used to do directly lives in the `app/`
package, split by responsibility:

| File | What it does |
|---|---|
| `main.py` | Builds the `Config` and the `Runtime`, starts everything, and waits |
| `app/cli.py` | Command-line flags → the final `Config` |
| `app/runtime.py` | The service's shared state: connected cameras, the zone aggregator, the detection-setting overrides — one object instead of module-level globals |
| `app/sources.py` | Webcam, RTSP and video-file capture, read directly with OpenCV (outside the stream-hub protocol) |
| `app/stream_hub.py` | Wires `ingest.server.StreamHubServer` to the runtime: each connection becomes one camera |
| `app/db.py` | Output sinks, zones and detection-setting overrides from the database, refreshed without a restart |
| `app/stats.py` | The periodic stats log line, the database status row (`ml_status`), and the Detection Settings payload they're both built from |
| `app/loop.py` | The main loop (runs the model for every camera, in turn) and the preview window |
| `app/model.py` | Loading the pose model and picking a device (GPU/CPU) |
| `ingest/protocol.py` | Length-prefixed handshake and frames (`[length][PTS][NALU]`), read without partial-read bugs |
| `ingest/decoder.py` | One decoder per camera; H.264 or H.265, detected from the stream; NALUs grouped into pictures by their PTS; frame-rate sampler |
| `ingest/buffer.py` | One camera's newest decoded frame, plus the throughput counters behind `rates()` / `take_stats()` |
| `ingest/server.py` | The stream-hub TCP server: one connection per camera, video in, results out on the same connection |
| `ingest/results.py` | The JSON messages sent back to stream-hub (detections, incident events, recording commands, snapshots) and the background writer that sends them without blocking inference |
| `pipeline.py` | Per-camera chain: newest frame → pose → features → rules → incidents |
| `reporting.py` | Turns incident/zone events and per-frame detections into sink records (database) and stream-hub messages (recording commands, snapshots, live detections) |
| `vision/pose.py` | People, 17 COCO keypoints, stable track IDs; picks GPU or CPU |
| `vision/overlay.py` | Draws boxes and labels on a frame, for the local preview window only |
| `fall/features.py` | Torso angle, box aspect ratio, hip height, head below hips |
| `fall/rules.py` | Labels each pose `upright`, `falling` or `lying` (Stage A, no training needed) |
| `fall/state_machine.py` | Down for `confirm_seconds` opens an incident; up for `recover_seconds` closes it |
| `fall/zones.py` | Merges incidents from cameras of the same zone, so one fall gives one alert |
| `sinks/` | Shared record format and local snapshots (`__init__.py`), JSONL files (`jsonl.py`), backend-module PostgreSQL on a background thread, including the `ml_status` row (`postgres.py`) |
| `config.py`, `config.yaml` | Typed settings with a dev and a prod section; documented in [CONFIG.md](CONFIG.md) |
| `tools/send_video.py` | Plays the part of stream-hub from a webcam or video file, including the PTS and tenant every real connection now sends |
| `tools/publish_webcam.py` | Publishes this PC's webcam to an RTSP server (the `test-camera` service), so it goes through the real gateway → hub → ML path |

What used to be `clips.py` and `viewer.py` are gone: stream-hub now records the clips and
stores the snapshots this service sends it, and the backend reads what this service is
doing from the database (`ml_status`, written by `sinks/postgres.py`) instead of calling an
HTTP endpoint here.

## Detection logic in detail

Detection happens in two layers. **Labels** describe one person in one frame. **Incidents**
are decisions made from a run of labels over time, so a single odd frame never raises an alarm.

### 1. What the model gives us

For each frame, YOLO26-pose returns every person with:

- a **bounding box**
- **17 keypoints** in COCO order (nose, eyes, ears, shoulders, elbows, wrists, hips, knees,
  ankles), each with a confidence. Keypoints below `min_keypoint_conf` (0.3) are ignored.
- a **track ID** from ByteTrack (`#1`, `#2`, ...) that follows the same person across frames,
  so each person gets their own labels and incidents

### 2. Measurements (`fall/features.py`)

| Measurement | How it is computed | What it tells us |
|---|---|---|
| Torso angle | Angle between the shoulder midpoint → hip midpoint line and vertical | 0° = upright, 90° = horizontal |
| Aspect ratio | Box width ÷ box height | Above 1 means wider than tall, typical of lying |
| Hip height | Hip midpoint y ÷ frame height | Used to measure how fast the hips drop |
| Hip drop speed | Change in hip height over the last ~8 samples, per second | Fast downward motion = a fall in progress |
| Head below hips | Nose lower in the image than the hip midpoint | Strong hint the person is on the floor |

If the shoulders or hips aren't visible with enough confidence, the torso angle is unknown
and only the box shape is used.

### 3. Labels (`fall/rules.py`)

Each person in each frame gets exactly one label and a confidence between 0 and 1.

| Label | Meaning | Preview colour |
|---|---|---|
| `upright` | Standing, walking, sitting: not on the way down and not lying | green |
| `falling` | Going down fast right now | orange |
| `lying` | On the floor, or horizontal | red |

The rules are checked in this order:

1. **Lying score.** Two scores from 0 to 1 are combined:
   - *angle score* rises from 0 at a 30° torso angle to 1 at `lying_torso_angle_deg` (60°)
   - *shape score* rises from 0 at aspect ratio 0.8 to 1 at `lying_aspect_ratio` (1.3)
   - lying score = 0.7 × angle score + 0.3 × shape score, plus 0.15 if the head is below the
     hips. With no torso angle, the shape score is used on its own.

   If the lying score is **0.75 or more**, the label is **`lying`**, with the score as its confidence.
2. **Falling.** Otherwise, if the hips are dropping at **`fall_velocity` (0.6 frame heights/s)
   or faster** and the torso is tilted **`falling_torso_angle_deg` (35°) or more**, the label is
   **`falling`**. Faster drops give higher confidence.
3. **Upright.** Anything else is **`upright`**, with confidence 1 − lying score.

### 4. Decisions: incidents (`fall/state_machine.py`)

Each tracked person has a small state machine. Being *down* means the label is `falling` or `lying`.

| Event | Triggered when | What happens |
|---|---|---|
| `incident_started` | The person has been down for `confirm_seconds` (3 s) **and** the current label is `lying` | A new incident opens with severity `medium`. Its start time is backdated to the first *down* frame, i.e. when the fall began. The current frame is used for a snapshot |
| `incident_updated` | The incident has lasted `high_after_seconds` (60 s), then `critical_after_seconds` (300 s) | Severity goes up to `high`, then `critical`. Highest confidence seen so far is kept as `peak_confidence` |
| `incident_recovered` | The person has been `upright` for `recover_seconds` (3 s) | The incident closes with status `recovered`. `recovered_at` is set to the first upright frame, so the database can work out how long they were down |
| `incident_unresolved` | The person hasn't been seen for `lost_track_seconds` (10 s) while an incident is open | The incident closes with status `unresolved`. This needs a human check, because the person may still be on the floor out of view |

What this filters out:

- **Bending over, crouching or sitting down quickly** may produce `falling` or `lying` for a
  moment. It only becomes an incident if it lasts 3 seconds.
- **A `falling` label alone never opens an incident.** The person has to end up `lying`.
- **One misdetected frame** doesn't close an incident either. Recovery needs 3 seconds of `upright`.

A camera that disconnects with an incident still open closes it as `unresolved`.

### 5. Zones: one alert per fall across overlapping cameras (`fall/zones.py`)

Each camera's state machine only knows its own people. Track IDs are per camera, so one
person seen by two cameras is two tracks. Cameras that see the same area are grouped into a
zone (`zones:` in `config.yaml`, see [CONFIG.md](CONFIG.md#zones)), and every camera-level
event passes through a shared aggregator:

| Camera-level event | Zone-level result |
|---|---|
| `incident_started`, no open incident in the zone within `merge_window_seconds` (10 s) from another camera | **`incident_started`**: a new zone incident |
| `incident_started`, an open incident in the zone started within the window and has no open fall from this camera | **`incident_updated`**: the camera joins it (closest start time wins) |
| `incident_updated` (severity rose) | `incident_updated` only if the zone incident's severity (highest of its cameras) changed |
| `incident_recovered` / `incident_unresolved` | Nothing until **every** camera has closed; then `incident_recovered` if any camera saw the person get up, else `incident_unresolved` |

Two falls on the *same* camera are never merged, because that camera's tracker already
tells the people apart. An unzoned camera is its own zone. Known limitation: two different
people falling within the window, each on a different camera of one zone, become one incident.

### 6. Outputs

Every result goes to each sink in `output.sinks` as the same record
([CONFIG.md → output](CONFIG.md#output)), via `reporting.py`
([CONFIG.md → database](CONFIG.md#database)).

**PostgreSQL** (`postgres` sink, the backend-module database; schema changes and details in
[backend-module/db/README.md](../backend-module/db/README.md)):

| Table | Written when |
|---|---|
| `incidents` | A fall is confirmed (insert); severity rises, a camera joins, or it closes (update) |
| `incident_cameras` | Each camera and tracked person that saw the incident, with its snapshot key and (once stream-hub has saved it) its clip key |
| `alerts` | One per incident, `open`, linked to the tenant's fall rule; severity and summary kept current, status left to staff |
| `model_predictions` | At most once per second per person; `incident_id` set while the person is part of an incident |
| `ml_status` | Rewritten every 10 s: what this service runs and how fast (model, device, analysed fps per camera, the `fall:` thresholds in use, zones) — platform-wide, not per tenant. This is what the frontend's Detection Settings page reads; see `app/stats.py` |

Writes run on a background thread and never slow detection; if the database is down they
are retried, and `tenant`/`camera` names are mapped to the schema's UUIDs
([CONFIG.md → database](CONFIG.md#database)).

**JSONL files** (`jsonl` sink, `data/`, git-ignored) hold the same records, minus `ml_status`:

| File | Written when | Contents |
|---|---|---|
| `model_predictions.jsonl` | At most once per second per person (`prediction_interval_s`) | Label, confidence, box, keypoints, torso angle, aspect ratio, hip speed, inference time, `incident_id` |
| `incidents.jsonl` | On every zone-level incident event above | Incident ID, event, status (`active` / `recovered` / `unresolved`), severity, start and recovery times, peak confidence, snapshot key, `camera_id` (first camera), `camera_ids` (all), `zone`, `tracks` |
| `clips.jsonl` | When stream-hub tells us it started recording a clip (webcam/RTSP/file sources only; see below) | Incident, camera, clip key |

**stream-hub** (a separate Go service, on the camera's own connection — see
`ingest/results.py` for the exact messages):

| Message | Sent when | What stream-hub does with it |
|---|---|---|
| `detections` | Every analysed frame, also with an empty list (so a live overlay clears) | Forwards it to whoever is watching that camera live |
| `incident` | Every zone-level incident event above | Forwards it the same way |
| `recording` (`start` / `stop`) | A camera's own incident starts / recovers or becomes unresolved | Starts or stops recording that camera's dashcam-style clip |
| `snapshot` | A camera confirms a fall (one per camera per incident) | Stores the JPEG this service already encoded |

This is why clips and stream-hub-stored snapshots only exist for cameras that come through
stream-hub: a webcam, RTSP or file source has no such connection, so `reporting.py` falls
back to saving the snapshot locally (`sinks.SnapshotStore`, under `data/snapshots/`) and
never asks for a clip.

Each incident event is also logged, e.g. `incident_started zone=... cameras=... severity=medium`,
and the preview window (`vision/overlay.py`) draws every person's box with
`#<track> <label> <confidence>`.

## Configuration

All settings live in `config.yaml`; [CONFIG.md](CONFIG.md) lists every option with its
default. The ones to tune first:

- `fall.confirm_seconds`: how long someone must stay down before an incident opens
- `fall.lying_torso_angle_deg`: torso angle from vertical that counts as lying
- `inference.weights`: `yolo26n-pose.pt` (fast) → `yolo26s-pose.pt` / `yolo26m-pose.pt` (more accurate)
- `inference.device`: `auto` (default) uses GPU 0 when CUDA is available and the CPU otherwise.
  A GPU index on a machine without CUDA falls back to the CPU with a warning. The startup log
  shows which one was picked: `model yolo26n-pose.pt ready on GPU 0 (...)`.
- `inference.half`: FP16 on GPU (sent to Ultralytics as `quantize=16`). Off by default.

## Deployment (Linux server container)

Production runs in a container on the on-prem Linux server with an NVIDIA GPU. It uses the
same `config.yaml` in prod mode (`ML_PROD_MODE=true`): stream-hub cameras, no preview,
listening on `0.0.0.0:9999` — the only port it exposes; there is no HTTP server here any
more (see [Architecture](#architecture)).

| File | Purpose |
|---|---|
| `Dockerfile` | Python 3.15 image with PyTorch (CUDA 13.0) and the YOLO26 weights baked in |
| `deploy/docker-compose.yml` | Runs the container with the GPU, port 9999 and a `ml-data` volume |

**Host requirements:** NVIDIA driver 580+ (for CUDA 13.0) and the NVIDIA Container Toolkit.
Check with `docker run --rm --gpus all ubuntu nvidia-smi`.

```bash
# 1. The database (creates the shared "fallguard" Docker network)
cd backend-module
cp .env.example .env                   # set POSTGRES_PASSWORD, ML_SERVICE_PASSWORD
docker compose up -d

# 2. ml-service (joins the network, reaches the database as db:5432)
cd ../ml-service/deploy
cp .env.example .env                   # ML_DATABASE_URL with the ML_SERVICE_PASSWORD
docker compose up -d --build
docker compose logs -f ml-service      # look for: model ... ready on GPU 0 (<server GPU>)
                                       #           database connected
```

Then point stream-hub at it: `ai_server_addr` in `stream-hub/config.json` = `<server>:9999`.
Details of the database setup: [backend-module/db/README.md](../backend-module/db/README.md).

How the image differs from the dev setup:

- **No workarounds needed.** The build stage has a C compiler, so the real PyYAML and `lap`
  are built and `compat/lap.py` stays unused.
- **Works offline.** The weights are downloaded at build time
  (`--build-arg YOLO_WEIGHTS=yolo26s-pose.pt` for a bigger model). The build also runs the
  tracker once, so a missing package fails the build instead of Ultralytics trying to
  `pip install` it on the server. Ultralytics' usage analytics are turned off.
- **Checks the config.** The build fails if `config.yaml` isn't valid in prod mode (e.g. a
  webcam under `prod:`), or if `prod:` expects different weights from the baked-in ones.
- **Runs as a non-root user**, with results in the `ml-data` volume (`/app/data`).
- **No preview window.** It turns off automatically when there is no display.

To change sources or thresholds without rebuilding, mount your own `config.yaml` over
`/app/config.yaml` (commented example in `deploy/docker-compose.yml`).

Port 9999 has no authentication, so keep it on the internal network.

### Capacity and performance

There is no camera limit in ml-service. (gateway-back streams up to 5 cameras *per gateway* at once;
stream-hub accepts several gateways.) The cameras share a fixed number of analysed frames
per second: each camera gets up to `inference.target_fps` (10), always on its newest frame,
and the share shrinks evenly when the machine is saturated.

Measured on the development laptop (RTX 3060 Laptop, i7-11800H), with simulated stream-hub
cameras sending 720p H.264 at 25 fps, `yolo26n-pose.pt`:

| Cameras | Analysed per camera | Total analysed | GPU busy | ml-service CPU |
|---|---|---|---|---|
| 1 | 9.6 fps | 10 fps | 34% | 0.5 cores |
| 4 | 9.1 fps | 36 fps | 31% | 1.7 cores |
| 8 | 3.6 fps | 29 fps | 29% | 2.6 cores |
| 12 | 1.8 fps | 22 fps | 36% | 3.4 cores |

What this shows:

- **About 4 cameras at full rate** on that laptop, and it keeps running beyond that with
  fewer frames per camera. Incidents still open at low rates, because a fall is confirmed
  by 3 s of `lying`; the `falling` label (hip speed) gets less reliable below ~5 fps.
- **The GPU is not the bottleneck** (about 30% busy). The limit is Python-side work: image
  preparation, tracking and per-camera decoding threads competing for the interpreter.
  The server's CPU matters as much as its GPU, and past ~4–6 cameras the total goes down
  slightly as more decoding threads compete.
- Only frames that may be analysed are converted from H.264 to images (at most 2 ×
  `target_fps` per camera); this took 4 cameras from 1.9 to 9.1 analysed fps.

On the server:

1. **Check the `stats:` log line** (every 30 s). A warning appears when cameras get fewer
   than 80% of `target_fps`.
2. **`inference.target_fps: 5`** roughly doubles the number of cameras at full rate and is
   still enough to detect falls.
3. **Bigger model** (`yolo26s-pose.pt`, `yolo26m-pose.pt`) if the GPU has headroom; it
   detects people more reliably.
4. **`inference.half: true` (FP16)**: compare first; it was slower on the laptop (58 vs 40 ms).
5. **Next code steps for many cameras** (not built yet): batch all cameras' frames into one
   model call, and move H.264 decoding into separate processes so it doesn't compete with
   the model loop.

## Threading

PyTorch 2.14 on Python 3.15 crashes the process if a tensor is created on any thread
other than the main one. So camera and connection threads only read and decode frames
(`CameraPipeline.submit`), and the main thread runs the model for every camera in turn
(`CameraPipeline.step`), always on each camera's newest frame. Keep any new PyTorch code
on the main thread.

This was seen on Windows. It may not happen on Linux or with a newer PyTorch, but the
design works either way.

## Tests

```bash
python -m pytest
```

`tests/test_postgres.py` is skipped unless `ML_TEST_DATABASE_URL` is set (see
[CONFIG.md → environment variables](CONFIG.md#environment-variables)); it runs the real
pipeline against a real database loaded with `backend-module/db/schema.sql` + `seed.sql`.

## Known gaps

- Snapshots and clips stored by stream-hub have no local fallback: if stream-hub's disk is
  unreachable or its recordings volume fills up, that photo or clip is simply lost (the
  database record still exists; only the file doesn't). Model predictions and incident
  records don't have this problem, because this service also writes them to local JSONL.
- **No authentication.** Neither stream-hub's camera connection (port 9999) nor its
  WebSocket to the frontend check who is connecting; both should stay on the internal
  network until this is addressed.
- gateway-back cameras live in gateway-back's own SQLite database and aren't registered in
  the backend `cameras` table, so their incidents have no camera name, location or DB zone
  until they are.
- Monthly partitions need a scheduled `create_monthly_partitions()` job run by the table
  owner (see [backend-module/db/README.md](../backend-module/db/README.md)).
- Stage B (a learned classifier over keypoint sequences, trained on public fall datasets)
  should replace `RuleClassifier` behind the same `classify()` interface.
- Cross-camera identity: zones stop duplicate alerts, but track IDs are still per camera.
  Telling two people apart across cameras would need a shared floor plan (camera
  calibration), not built yet.
- Throughput beyond ~4–6 cameras per machine needs batched inference and out-of-process
  decoding (see [Capacity and performance](#capacity-and-performance)).

Ultralytics YOLO is licensed AGPL-3.0.