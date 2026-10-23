# ML Service — Fall Detection

Watches camera video and notices when someone falls and stays down.

- **[Part 1 — What it does](#part-1--what-it-does)**: for everyone, no technical background needed
- **[Part 2 — Technical reference](#part-2--technical-reference)**: architecture, detection logic,
  setup, configuration and deployment

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
| **IP cameras** (security cameras on the network) | The real setup. The cameras send video through the project's gateway and stream hub |
| **A webcam on a laptop or PC** | Trying things out and demos |
| **A recorded video** | Replaying a fall to test the system |

It can watch several cameras at the same time. A webcam is handled exactly like an IP
camera, so what you see in a demo is what happens with real cameras.

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
   them on the floor) → the incident is marked **unresolved**, meaning someone should check.

Things that do **not** count as a fall: bending over to pick something up, crouching,
sitting down quickly, or a single frame where the camera briefly misreads someone.

All the timings above can be changed in the settings.

## What happens after a fall (today)

- The incident is **saved to a file** with its start time, severity, how sure the system
  was, and when the person recovered.
- A **photo** of the moment is saved.
- On a screen with the live view, the person's box turns **red**.

The field names match the project's database design, so connecting it to the main system
later is straightforward.

## Try it yourself

1. Open `ml-service` in VS Code and run `main.py` (it uses your webcam by default).
2. Wait for the message `model ... ready`, about 5–15 seconds.
3. Stand in view: you should see a **green** box with your number, e.g. `#1 upright`.
4. Lie down on the floor: the box turns **red**, and after 3 seconds the log shows
   `incident_started` and a photo appears in `data/snapshots/`.
5. Stand up: 3 seconds later the log shows `incident_recovered`.
6. Press `q` in the video window to stop.

## Not done yet

- **No alerts.** Nothing sends a message, email or notification yet, and incidents don't
  appear in the web app yet. They are saved to files.
- **Rules, not a trained model.** The decision is made by hand-tuned rules, so expect some
  false alarms or misses until they are tuned on real footage. A trained model is planned.
- **Overlapping cameras.** If two cameras see the same person, they count as two people and
  a fall may be recorded twice.

---

# Part 2 — Technical reference

Replaces `mock/receiver.py` (kept as a reference) and speaks the same TCP protocol
on port `9999` (`ai_server_addr` in `stream-hub/config.json`). Runs on a Windows PC for
prototyping and in a Linux container on the GPU server for production
(see [Deployment](#deployment-linux-server-container)).

## Architecture

```
stream-hub (H.264) ─► decode (PyAV) ─┐
webcam / RTSP / file (OpenCV) ───────┴─► newest frame ─► YOLO26-pose + ByteTrack (≤ 10 fps)
   ─► pose features ─► fall rules ─► incident state machine ─► data/*.jsonl
```

Every source becomes a camera with its own tracker, fall state and outputs. A webcam goes
through exactly the same steps as an IP camera, so prototyping results carry over.

| Step | File | What it does |
|---|---|---|
| Entry point | `main.py` | Starts the sources, runs the model for every camera on the main thread, preview window |
| Protocol | `ingest/protocol.py` | Length-prefixed handshake and NALUs, read without partial-read bugs |
| Decode | `ingest/decoder.py` | One H.264 decoder per camera, frame-rate sampler |
| Pipeline | `pipeline.py` | Per-camera chain: newest frame → pose → features → rules → incidents → sink |
| Pose | `vision/pose.py` | People, 17 COCO keypoints, stable track IDs; picks GPU or CPU |
| Features | `fall/features.py` | Torso angle, box aspect ratio, hip height, head below hips |
| Rules | `fall/rules.py` | Labels each pose `upright`, `falling` or `lying` (Stage A, no training needed) |
| Incidents | `fall/state_machine.py` | Down for `confirm_seconds` opens an incident; up for `recover_seconds` closes it |
| Output | `sinks/jsonl.py` | `model_predictions.jsonl`, `incidents.jsonl`, snapshots; fields match `backend-module/db/schema.sql` |
| Config | `config.py`, `config.yaml` | Typed settings with a dev and a prod section; documented in [CONFIG.md](CONFIG.md) |
| Test sender | `tools/send_video.py` | Plays the part of stream-hub from a webcam or video file |

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
| `incident_started` | The person has been down for `confirm_seconds` (3 s) **and** the current label is `lying` | A new incident opens with severity `medium`. Its start time is backdated to the first *down* frame, i.e. when the fall began. The current frame is saved as a snapshot |
| `incident_updated` | The incident has lasted `high_after_seconds` (60 s), then `critical_after_seconds` (300 s) | Severity goes up to `high`, then `critical`. Highest confidence seen so far is kept as `peak_confidence` |
| `incident_recovered` | The person has been `upright` for `recover_seconds` (3 s) | The incident closes with status `recovered`. `recovered_at` is set to the first upright frame, so the database can work out how long they were down |
| `incident_unresolved` | The person hasn't been seen for `lost_track_seconds` (10 s) while an incident is open | The incident closes with status `unresolved`. This needs a human check, because the person may still be on the floor out of view |

What this filters out:

- **Bending over, crouching or sitting down quickly** may produce `falling` or `lying` for a
  moment. It only becomes an incident if it lasts 3 seconds.
- **A `falling` label alone never opens an incident.** The person has to end up `lying`.
- **One misdetected frame** doesn't close an incident either. Recovery needs 3 seconds of `upright`.

### 5. Outputs

All output goes to `data/` (git-ignored), using the field names of
`backend-module/db/schema.sql` so the backend can store records unchanged.

| File | Written when | Contents |
|---|---|---|
| `model_predictions.jsonl` | At most once per second per person (`prediction_interval_s`) | Label, confidence, box, keypoints, torso angle, aspect ratio, hip speed, inference time |
| `incidents.jsonl` | On every incident event above | Incident ID, event, status (`active` / `recovered` / `unresolved`), severity, start and recovery times, peak confidence, snapshot path |
| `snapshots/<incident id>.jpg` | On `incident_started` | The frame at the moment the fall was confirmed |

Each event is also logged, e.g. `incident_started track=1 severity=medium`, and the preview
window draws every person's box with `#<track> <label> <confidence>`.

## Setup (Windows, Python 3.15, NVIDIA GPU)

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

```powershell
python main.py                                      # whatever config.yaml says
python main.py --prod                               # try the prod settings
python main.py --webcam 0 --tcp                     # a webcam next to the stream-hub cameras
python main.py --rtsp rtsp://user:pw@10.0.0.21/s1   # an IP camera
python main.py --video fall.mp4                     # a video file
python main.py --no-show                            # no preview window
```

Wait for `model ... ready` in the log (about 5–15 s), then step into view.
Results go to `data/` (git-ignored). Press `q` in the window to quit.

To test the TCP path without the Go services, `tools/send_video.py --source 0` plays the
part of stream-hub.

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
listening on `0.0.0.0:9999`.

| File | Purpose |
|---|---|
| `Dockerfile` | Python 3.15 image with PyTorch (CUDA 13.0) and the YOLO26 weights baked in |
| `deploy/docker-compose.yml` | Runs the container with the GPU, port 9999 and a `ml-data` volume |

**Host requirements:** NVIDIA driver 580+ (for CUDA 13.0) and the NVIDIA Container Toolkit.
Check with `docker run --rm --gpus all ubuntu nvidia-smi`.

```bash
cd ml-service/deploy
docker compose up -d --build
docker compose logs -f ml-service      # look for: model ... ready on GPU 0 (<server GPU>)
```

Then point stream-hub at it: `ai_server_addr` in `stream-hub/config.json` = `<server>:9999`.

How the image differs from the Windows setup:

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
`/app/config.yaml` (commented example in `docker-compose.yml`).

Port 9999 has no authentication, so keep it on the internal network.

### Performance on the server

Measure before changing anything; `inference_ms` in `model_predictions.jsonl` shows the
time per frame.

1. **Bigger model.** A stronger GPU can afford `yolo26s-pose.pt` or `yolo26m-pose.pt`,
   which detect people more reliably.
2. **`inference.half: true` (FP16).** Usually faster on data-center GPUs, but it was slower
   on an RTX 3060 laptop with the nano model (58 vs 40 ms), so compare first.
3. **More cameras.** The main thread runs the model for each camera in turn. If the GPU
   still has headroom with many cameras, the next step is batching all cameras' frames
   into one model call (not built yet).

## Threading

PyTorch 2.14 on Python 3.15 crashes the process if a tensor is created on any thread
other than the main one. So camera and connection threads only read and decode frames
(`CameraPipeline.submit`), and the main thread runs the model for every camera in turn
(`CameraPipeline.step`), always on each camera's newest frame. Keep any new PyTorch code
on the main thread.

This was seen on Windows. It may not happen on Linux or with a newer PyTorch, but the
design works either way.

## Tests

```powershell
python -m pytest
```

## Known gaps

- The Docker image has not been built yet: there is no Docker on the development PC.
  Build it on the server (or any Linux machine with Docker) before relying on it.
- Results are written to local files. Sending them to `backend-module` is the next step.
- Stage B (a learned classifier over keypoint sequences, trained on public fall datasets)
  should replace `RuleClassifier` behind the same `classify()` interface.
- Cross-camera identity: track IDs are per camera, so one person seen by two overlapping
  cameras gives two tracks and possibly two incidents.
- stream-hub's `ai_worker.go` sends only `camera_id`, so `tenant_id` comes from
  `handshake.default_tenant_id`. Set `tenant_in_handshake: true` once the hub sends it.
- stream-hub drops NALUs when the AI buffer is full, which corrupts decoding until the
  next keyframe. It should drop up to the next keyframe instead.

Ultralytics YOLO is licensed AGPL-3.0.
