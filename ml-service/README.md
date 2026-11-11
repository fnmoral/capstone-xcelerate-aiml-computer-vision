# ML Service — Fall Detection

Watches camera video and notices when someone falls and stays down.

- **[Part 1 — What it does](#part-1--what-it-does)**: for everyone, no technical background needed
- **[Part 2 — Technical reference](#part-2--technical-reference)**: setup, running it, then
  architecture (every file, and how it talks to stream-hub), what changed in this version,
  detection logic and deployment

---

# Part 1 — What it does

## In short

The service looks at live camera video, finds every person in view, and keeps checking
whether each one is **standing**, **falling** or **lying on the floor**. If someone falls and
stays down for a few seconds, it records a **fall incident** with the time, how serious it
is, and a photo of the moment. When the person gets back up, it records that they recovered
and how long they were down.

It does **not** show video itself. The live picture, with a coloured box around every
person, appears in the web app: the camera video goes through **stream-hub**, which relays it
to the browser, and this service sends the boxes and labels back to stream-hub to be drawn on
top. The incident video clips and photos are saved by stream-hub too.

## What it can watch

| Camera | When it's used |
|---|---|
| **IP cameras** (security cameras on the network) | The real setup. The cameras send video through the project's gateway and stream-hub |
| **A webcam on a laptop or PC** | Trying things out and demos |
| **A recorded video** | Replaying a fall to test the system |

It can watch several cameras at the same time. A webcam is handled exactly like an IP
camera, so what you see in a demo is what happens with real cameras — except that a webcam
or file has no stream-hub behind it, so it has no live overlay in the web app and no
recorded clips (the demo shows its own preview window instead; see [Outputs](#6-outputs)).

**Cameras that overlap.** When two or more cameras look at the same room, they can be
grouped into a *zone*. A fall seen by several cameras of a zone is then recorded **once**,
with every camera that saw it and a photo from each, instead of raising one alert per camera.

## What it recognises

For every person, several times a second, it decides one of four states:

| State | What it means | Colour on screen |
|---|---|---|
| **Upright** | Standing, walking or sitting: everything normal | 🟢 green |
| **Falling** | Going down quickly right now | 🟠 orange |
| **Lying** | On the floor | 🔴 red |
| **Unclear** | Too little of the person is visible to tell (cut off by the edge of the picture, behind furniture, far away). It never starts or ends an incident | ⚪ grey |

It works this out from the position of the body: it finds points like the shoulders, hips,
knees and head, then looks at how tilted the body is, whether it's wider than it is tall,
how straight the legs are and how fast the hips are dropping. Each person in view is
followed separately, so two people in the same room each get their own state.

## When does it decide someone has fallen?

A single glance is not enough, because people bend down, crouch and sit all the time. So the
service waits to be sure:

1. **Someone goes down and is still lying after 3 seconds** (and was down for most of those
   3 seconds) → a **fall incident starts**. A photo is saved, and the start time is set to
   the moment they began to fall.
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
  through stream-hub (the real setup), this service only *takes* the photo and sends it;
  stream-hub is what stores it. For a webcam, RTSP or video-file source used while
  prototyping, this service stores it itself, in `data/snapshots/`.
- A **video clip** is saved from each camera that saw it, like a car dashcam: from 15
  seconds before the fall until 10 seconds after the person is back up (or out of view).
  This is entirely stream-hub's job: it keeps a short loop of each camera's video, and this
  service only tells it when to start and stop. So it only happens for cameras that come
  through stream-hub.
- Model predictions and incident records are also kept in local files on this machine, so
  nothing is lost if the database is unreachable for a while; the service keeps detecting
  and catches up when the database is back. (Clips and stream-hub-stored photos don't have
  this fallback: they only exist where stream-hub saved them.)
- The web app's **Detection Settings** page shows how the service is doing (model, speed,
  thresholds). The service writes this to the database every 10 seconds; the web app and
  backend never talk to the service directly.

## Try it yourself

1. Open `ml-service` in VS Code and run `main.py` (it uses your webcam by default).
2. Wait for the message `model ... ready`, about 5–15 seconds.
3. Stand in view: you should see a **green** box with your number, e.g. `#1 upright`.
4. Lie down on the floor: the box turns **red**, and after 3 seconds the log shows
   `incident_started` and a photo appears in `data/snapshots/` (this is the webcam path;
   see the note above).
5. Stand up: 3 seconds later the log shows `incident_recovered`.
6. Press `q` in the video window to stop.

To try the real path (video → stream-hub → ml-service → web app) without real cameras, see
[Running](#running-dev-and-prod-mode).

## Not done yet

- **No notifications.** Alerts are stored in the database, but nothing sends an email or
  message yet.
- **Rules by default, a trained model as an option.** The decision is made by hand-tuned
  rules, so expect some false alarms or misses until they are tuned on real footage. A
  trained classifier ("Stage B") exists but catches more false alarms, so it is off by
  default (see [Detection logic](#detection-logic-in-detail)).
- **Overlapping cameras need setting up.** Cameras only merge their alerts once they are
  grouped into a zone. And if two different people fall at almost the same moment, each
  seen by a different camera of the same zone, they are recorded as one fall.
- **No authentication on the video path.** stream-hub's connections (the one this service
  uses, and the one the frontend uses) have no login; see [Known gaps](#known-gaps).

---

# Part 2 — Technical reference

Speaks a length-prefixed TCP protocol with stream-hub, on port `9999` (`ai_server_addr` in
`stream-hub/config.json`). The other end of the protocol is stream-hub's
`internal/hub/ai_worker.go`; the format is documented in full at the top of
`app/camera_service/video_input.py` and `app/camera_service/hub_results.py`. Runs on a
Windows PC for prototyping and in a Linux container on the GPU server for production (see
[Deployment](#deployment-linux-server-container)).

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
  `app/detection/lap_compat/lap.py` stands in for it using Ultralytics' own NumPy solver and
  is only used when the real package is missing. Delete `lap_compat/` once `pip install lap`
  works.

The standard weights (`models/yolo26n-pose.pt`) and the fine-tuned ones are in the repo
(see [models/README.md](models/README.md)); a standard model that isn't in `models/` (e.g.
`yolo26s-pose.pt`) downloads on first run.

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
prebuilt wheels there, so `lap_compat/` stays unused. The Windows section above (and its
`PYYAML_FORCE_LIBYAML=0` step) is only for Python 3.15, which doesn't have those wheels yet;
on Linux/macOS the equivalent is the same environment variable, set the bash way:

```bash
PYYAML_FORCE_LIBYAML=0 pip install -r requirements.txt   # only needed on Python 3.15
```

**If the preview window (`cv2.imshow`) fails with a `libGL` error**, install the same
system packages the Docker image uses: `sudo apt install libgl1 libglib2.0-0`
(Debian/Ubuntu; other distributions have equivalent packages). You don't need this at all
if you only run with `--no-show`.

**On WSL (Windows Subsystem for Linux)**, a PC's webcam isn't visible by default — `/dev/video*`
is simply empty, even though Windows sees the camera fine — so `--webcam` won't find one.
Either pass the camera through with `usbipd-win` (it then stops being usable from Windows
while attached), or skip the webcam path and use `--video some-recording.mp4` or
`setup_and_tools/fake_cameras/send_video.py --source some-recording.mp4` instead, which need
no camera at all and exercise the same detection code (see [Try it yourself](#try-it-yourself)
above and [Command-line flags](CONFIG.md#command-line-flags)).

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

| `type` | Video from | Allowed in | Live overlay and clips in the web app? |
|---|---|---|---|
| `tcp` | every camera stream-hub sends, port 9999 | dev, prod | **yes** |
| `rtsp` | an IP camera, read directly | dev, prod | no |
| `webcam` | a camera plugged into this PC | dev | no |
| `file` | a local video | dev | no |

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

**Testing the stream-hub path without the Go services.** `setup_and_tools/fake_cameras/send_video.py`
plays the part of stream-hub (same wire protocol, including the PTS and the tenant in the
handshake):

```bash
python setup_and_tools/fake_cameras/send_video.py --source 0 --tenant-id demo-facility            # webcam
python setup_and_tools/fake_cameras/send_video.py --source fall.mp4 --tenant-id demo-facility --loop
```

Pass `--tenant-id` whenever `handshake.tenant_in_handshake` is on, which the shipped config
always has. To go through the *real* gateway → stream-hub → ml-service path with this PC's
webcam, run `setup_and_tools/fake_cameras/publish_webcam.py`, which publishes the webcam as
an RTSP camera (see its header for the Docker `test-camera` service it needs).

## Architecture

```
stream-hub ──[length][PTS][H.264/H.265 NALU]──► hub_server.py ─► video_input.py
   ▲  (one TCP connection per camera, port 9999)     decode (PyAV), grouped by PTS
   │                                                            │
   │                                                            ▼
   │                                              frame_buffer.py: the camera's newest frame + its PTS
   │                                                            │
   │       webcam / RTSP / file (sources.py) ───────────────────┤  (same pipeline, no stream-hub)
   │                                                            ▼
   │      main thread, loop.py ─► camera_pipeline.py ─► pose_model.py: YOLO26-pose + ByteTrack (≤ 10 fps)
   │                                       │
   │                                       ├─► fall_detection.py: measurements → labels → incident timing
   │                                       ├─► zones (IncidentAggregator): one alert per fall across cameras
   │                                       ▼
   │                              incident_reporter.py ──┬─► results.py / database.py ─► data/*.jsonl, PostgreSQL
   │                                                     │
   └──[length][JSON]── hub_results.py (own thread) ◄─────┘   detections · incident · recording · snapshot
```

Every source becomes a camera with its own tracker, fall state and outputs. A webcam goes
through exactly the same detection steps as an IP camera, so prototyping results carry
over — the difference is only in what leaves the service: a stream-hub camera has a
connection to send results back on; a webcam, RTSP or file source does not, so it only
writes to the sinks (and draws its own preview window).

### File structure

```
ml-service
 ┣ app                                  ★ THE LIVE SYSTEM (what runs on the cameras)
 ┃ ┣ camera_service                     video in, results out        ⇄ = talks to stream-hub
 ┃ ┃ ┣ __init__.py
 ┃ ┃ ┣ camera_pipeline.py               one camera from frames to incidents; zones merge cameras of one area
 ┃ ┃ ┣ database.py                      the PostgreSQL database
 ┃ ┃ ┣ frame_buffer.py                  the camera's newest frame and its PTS
 ┃ ┃ ┣ hub_results.py                   ⇄ the JSON results sent back to stream-hub
 ┃ ┃ ┣ hub_server.py                    ⇄ the TCP server stream-hub connects to
 ┃ ┃ ┣ incident_reporter.py             ⇄ turns incidents into database records AND stream-hub messages
 ┃ ┃ ┣ results.py                       the shared record format, JSONL files, local snapshots
 ┃ ┃ ┣ video_input.py                   ⇄ stream-hub's messages (protocol) and decoding video into frames
 ┃ ┃ ┗ viewer.py                        NOT USED (kept on purpose, see "What changed")
 ┃ ┣ detection                          ★ THE MACHINE-LEARNING MODEL
 ┃ ┃ ┣ lap_compat
 ┃ ┃ ┃ ┗ lap.py                         stand-in for the `lap` package on Python 3.15
 ┃ ┃ ┣ __init__.py
 ┃ ┃ ┣ fall_detection.py                who has fallen: 1 measurements · 2 rules · 3 learned model · 4 incident timing · 5 FallDetector
 ┃ ┃ ┣ overlay.py                       boxes and labels for the local preview window only
 ┃ ┃ ┗ pose_model.py                    YOLO26-pose: people, 17 body points, track IDs
 ┃ ┣ __init__.py
 ┃ ┣ cli.py                             command-line flags → Config
 ┃ ┣ config.py                          reads config.yaml
 ┃ ┣ db.py                              output sinks; zones and settings from the database
 ┃ ┣ loop.py                            the main loop (runs the model for every camera) and the preview window
 ┃ ┣ model.py                           loading the pose model, picking GPU or CPU
 ┃ ┣ runtime.py                         the shared state: connected cameras, zones, settings overrides
 ┃ ┣ sources.py                         webcam, RTSP and video-file sources (no stream-hub)
 ┃ ┣ stats.py                           the stats log line and the ml_status row
 ┃ ┗ stream_hub.py                      ⇄ wires the TCP server to the runtime
 ┣ evaluation                           ★ TESTING THE MODEL
 ┃ ┣ results                            every saved benchmark run, 00-baseline.json to 12-test-finetuned15-stageb.json
 ┃ ┣ __init__.py
 ┃ ┣ datasets.py                        1 synthetic scenarios · 2 Multiple Cameras Fall Dataset (+ train/test split)
 ┃ ┣ evaluate.py                        the benchmark: falls caught, false alarms
 ┃ ┗ videos.yaml                        the recorded test videos and their ground truth
 ┣ model_finetuning                     ★ IMPROVING THE MODEL
 ┃ ┣ reports                            the latest report: fine_tuning_report.xlsx, its CSV tables and PNG charts
 ┃ ┣ __init__.py
 ┃ ┣ finetune.py                        1 pose labels · 2 fine-tune the pose model · 3 Stage B classifier
 ┃ ┗ report.py                          Excel/CSV/charts: per-epoch progress, hyperparameters, before vs after
 ┣ models                               the model files to choose from (see models/README.md)
 ┃ ┣ README.md
 ┃ ┣ stage_b.json                       the learned classifier's model card
 ┃ ┣ stage_b.npz                        the learned fall classifier
 ┃ ┣ yolo26n-pose-finetuned-mcfDataset-111026.pt   pose model fine-tuned for falls (the default)
 ┃ ┗ yolo26n-pose.pt                    the standard pose model
 ┣ setup_and_tools                      everything around the app
 ┃ ┣ docker_server
 ┃ ┃ ┣ .env.example
 ┃ ┃ ┣ Dockerfile
 ┃ ┃ ┗ docker-compose.yml               the GPU server container
 ┃ ┣ fake_cameras                       fake cameras for testing without real ones
 ┃ ┃ ┣ make_test_videos.py
 ┃ ┃ ┣ publish_webcam.py
 ┃ ┃ ┗ send_video.py                    ⇄ plays the part of stream-hub
 ┃ ┗ tests                              automatic checks, one file per module (python -m pytest)
 ┃ ┃ ┣ test_camera_pipeline.py
 ┃ ┃ ┣ test_clips.py
 ┃ ┃ ┣ test_config.py
 ┃ ┃ ┣ test_database.py
 ┃ ┃ ┣ test_evaluation.py
 ┃ ┃ ┣ test_fall_detection.py
 ┃ ┃ ┣ test_model_finetuning.py
 ┃ ┃ ┣ test_pose_model.py
 ┃ ┃ ┣ test_stream_hub.py
 ┃ ┃ ┣ test_video_input.py
 ┃ ┃ ┗ test_viewer.py
 ┣ .dockerignore
 ┣ .gitignore
 ┣ CONFIG.md                            every setting
 ┣ DETECTION_CHANGELOG.md               every change to the detection logic, with benchmark numbers
 ┣ README.md
 ┣ config.yaml                          the settings (dev and prod sections)
 ┣ main.py                              start here: `python main.py`
 ┣ pytest.ini
 ┗ requirements.txt
```

### File reference

"stream-hub?" says whether the file takes part in the conversation with stream-hub:
**receives** = reads what stream-hub sends, **sends** = writes results back to it,
**indirect** = works on data that came from or goes to it, **no** = unrelated.

#### Entry point and start-up (`main.py`, `app/`)

| File | What it does | stream-hub? |
|---|---|---|
| `main.py` | A thin script: builds the `Config`, the output sinks, the `Runtime` and the model, starts the sources and the stream-hub listener, starts two small threads (one refreshes zones and settings from the database, one writes the `ml_status` row), and runs the main loop. Everything else lives in `app/` | starts the listener |
| `app/cli.py` | Command-line flags (`--prod`, `--webcam`, `--tcp`, ...) → the final `Config`. Also reads `ML_CONFIG` | no |
| `app/config.py` | Reads `config.yaml` into typed settings, picks the dev or prod section, and checks everything at start-up. Holds the connection settings stream-hub depends on (`server`, `handshake`) | no |
| `app/runtime.py` | The service's shared state in one object (no module-level globals): the connected cameras, the zone aggregator, the detection-setting overrides from the frontend. Registers a camera when a stream-hub connection opens and unregisters it when it closes (which turns its open incidents into `unresolved`) | indirect |
| `app/stream_hub.py` | Wires the TCP server to the runtime: each stream-hub connection becomes one camera pipeline, with a `publish` function to send results back on that connection | **receives + sends** |
| `app/db.py` | Builds the output sinks from `output.sinks`; loads zones and detection-setting overrides from the database and refreshes them every 15 s without a restart | no |
| `app/stats.py` | The periodic `stats:` log line (frames received/analysed per second, model time, saturation warning), and the `ml_status` row written to the database every 10 s for the frontend's Detection Settings page | no (this is what replaced the backend's HTTP calls) |
| `app/loop.py` | The main loop: runs the model for every camera in turn, on the main thread (see [Threading](#threading)), and draws the optional preview window | indirect |
| `app/model.py` | Loads the pose model and runs it once at start-up, so CUDA start-up happens before cameras connect; reports which device was picked | no |
| `app/sources.py` | Webcam, RTSP and video-file capture, read directly with OpenCV, with automatic reconnection. Each becomes its own camera pipeline | no: these cameras have no stream-hub connection, so no live overlay and no clips |

#### Video in, results out (`app/camera_service/`)

| File | What it does | stream-hub? |
|---|---|---|
| `hub_server.py` | The TCP server on port 9999. One thread per connection: reads the handshake (tenant and camera ID), creates the camera, feeds it every video message, and closes it when the connection ends. Turns on `TCP_NODELAY`, because Python leaves Nagle's algorithm on (unlike Go) and that shows up as video arriving in bursts | **receives** |
| `video_input.py` | Part 1: the wire protocol (`[length][PTS][NALU]`, handshake, `read_frame`, `write_frame`). Part 2: one decoder per camera (H.264 or H.265, detected from the stream), NALUs grouped into pictures by their PTS so every frame keeps its capture time, and the sampler that picks only as many frames as the model needs | **receives** |
| `hub_results.py` | The JSON messages sent back (`detections`, `incident`, `recording`, `snapshot`) and `ResultWriter`, a background thread per camera that sends them. `publish()` never blocks inference: when stream-hub reads slowly, old `detections` are dropped first; the rare messages (incidents, recording commands, snapshots) are never dropped and go out first | **sends** |
| `frame_buffer.py` | Holds the camera's newest decoded frame with its PTS (a slow model never falls behind: it always gets the latest) and the counters behind the stats line | indirect |
| `camera_pipeline.py` | Part 1, `CameraPipeline`: one camera from newest frame → pose → fall detector → incidents → reporting. Carries each frame's PTS through to the detections, so the frontend can draw the boxes on the right picture. Part 2, zones: the `IncidentAggregator` that merges cameras looking at the same area | indirect |
| `incident_reporter.py` | The only place that knows every output of an incident. One incident event becomes database records **and** the stream-hub messages: `recording start`/`stop`, a `snapshot` with the JPEG, an `incident` event. Also sends the per-frame `detections` | **sends** |
| `results.py` | The record format shared by all sinks, the JSONL files, `SnapshotStore` (local photos, only for sources without stream-hub), and the names (`snapshot_key`, `clip_key`) that this service and stream-hub both use for the files stream-hub stores | indirect (agreed file names) |
| `database.py` | `PostgresSink`: the backend-module database, on a background thread with retries; incidents, alerts, predictions, the `ml_status` row, zones and settings overrides | no |
| `viewer.py` | **Not used.** The old live view in the browser on port 8000. Kept on purpose; has its own tests (`test_viewer.py`) | no |

#### The model (`app/detection/`)

| File | What it does | stream-hub? |
|---|---|---|
| `pose_model.py` | YOLO26-pose and ByteTrack: people, 17 body points, track IDs. A person is reported once at `conf`, then tracked down to `track_conf` | no |
| `fall_detection.py` | Everything between body points and incidents: 1 measurements (angles, shape, speed), 2 the rules, 3 the optional learned classifier, 4 the incident timing, 5 `FallDetector`, the one object the live service and the benchmark both use | no |
| `overlay.py` | Draws boxes and labels on a frame for the **local** preview window. The web app draws its own from the `detections` messages | no |
| `lap_compat/lap.py` | Stand-in for the `lap` package where it can't be installed (Python 3.15) | no |

#### Around the app

| Path | What it is | stream-hub? |
|---|---|---|
| `config.yaml`, `CONFIG.md` | The settings and their documentation | no |
| `models/` | Pose models (`*.pt`) and the learned fall classifier (`stage_b.npz`); [models/README.md](models/README.md) lists them | no |
| `evaluation/` | The benchmark (`python -m evaluation.evaluate`): scripted scenarios, recorded videos, the Multiple Cameras Fall Dataset | no |
| `model_finetuning/` | Training: label the dataset, fine-tune the pose model, train the learned classifier, write the report | no |
| `DETECTION_CHANGELOG.md` | Every change to the detection logic and what it did to the benchmark numbers | no |
| `setup_and_tools/docker_server/` | `Dockerfile`, `docker-compose.yml`, `.env.example` for the GPU server | the container exposes port 9999 for it |
| `setup_and_tools/fake_cameras/send_video.py` | Plays the part of stream-hub from a webcam or video file, with the real protocol | **sends video** (as stream-hub) |
| `setup_and_tools/fake_cameras/publish_webcam.py` | Publishes this PC's webcam as an RTSP camera, so it takes the real gateway → stream-hub path | indirect |
| `setup_and_tools/fake_cameras/make_test_videos.py` | Makes the test videos and their ground truth from the dataset | no |
| `setup_and_tools/tests/` | The automatic checks (see [Tests](#tests)) | `test_stream_hub.py` simulates it |
| `pytest.ini`, `requirements.txt`, `.dockerignore` | Test settings, Python packages, Docker build exclusions | no |

### How ml-service and stream-hub talk

One TCP connection **per camera**, opened by stream-hub, carrying video one way and results the
other. Every number is big-endian.

```
stream-hub → ml-service   handshake, once:   [u32 length][tenant id]   (if handshake.tenant_in_handshake)
                                             [u32 length][camera id]
stream-hub → ml-service   video, repeated:   [u32 length][i64 PTS][one H.264 or H.265 NALU]
ml-service → stream-hub   results, any time: [u32 length][one JSON object]
```

- The **PTS** is the picture's capture time in Unix milliseconds, set by the gateway. Every
  NALU of one picture carries the same PTS, so the decoder can tell where a picture ends and
  every decoded frame keeps its own timestamp.
- The **codec** (H.264 or H.265) isn't signalled; it is read from the stream's parameter sets.
- The service never sends a result for a frame it didn't analyse: it analyses at most
  `inference.target_fps` (10) frames per second per camera, so about one in three.

The results, in `hub_results.py`:

| Message | Sent when | What stream-hub does with it |
|---|---|---|
| `detections` | Every analysed frame, also with an empty list (so the overlay clears). Carries the frame's `pts`, its size, and each person's track, label, confidence, box (0..1 of the frame) and open `incident_id` | Relays it to the frontend over its WebSocket. The frontend shows each video frame ~300 ms late and draws on it the newest detection whose PTS is at or before the frame's (and no older than 1 s) |
| `incident` | Every zone-level incident event (started, updated, recovered, unresolved) | Relays it the same way |
| `recording` (`start` / `stop`) | This camera's incident starts / recovers or becomes unresolved | Starts or finishes that camera's clip, saved as `clips/<incident_id>_<camera_id>.mp4` |
| `snapshot` | This camera confirms a fall (one per camera per incident) | Stores the JPEG as `snapshots/<name>` |

Why this design matters for performance: the frontend waits 300 ms for each frame's
detections (`DISPLAY_DELAY_MS` in the frontend's `LiveVideo.tsx`), expecting about 100–200 ms
for decode + inference + network. If the model is slow, the boxes arrive late; the
`stats:` line (`analysed=… model=…ms`) shows whether the service is keeping up.

### What changed in this version

This version merges two lines of work: the **stream-hub integration** (how video comes in and
results go out) and the **detection improvements** (what is decided, and how well). It also
reorganises the folders.

#### 1. The stream-hub integration

| Change | Before | Now | Why |
|---|---|---|---|
| **PTS on every video message** | `[length][NALU]`; the service stamped frames with its own clock | `[length][PTS][NALU]`; the decoder groups NALUs by PTS and each frame keeps its capture time | So a box can be drawn on the exact picture it was computed from, whatever the network or model delay |
| **Results go back on the same connection** | One-way: video in, nothing out | `detections`, `incident`, `recording`, `snapshot` messages, sent by a per-camera writer thread that can't block inference | The web app draws the overlay from them, and stream-hub knows when to record |
| **The viewer is gone from the pipeline** (`viewer.py`) | ml-service served the live view over HTTP on port 8000 (MJPEG, snapshots, clips) and the backend called it (`ML_URL`) | No HTTP server, no port 8000, no call from the backend. The browser watches video through stream-hub, with boxes drawn by the frontend. The file is kept but nothing imports it | One place serves video (stream-hub); the backend no longer depends on ml-service being reachable |
| **Clips are recorded by stream-hub** | `ClipRecorder` (in `clips.py`) buffered video inside ml-service and wrote the clip | The pipeline sends `recording start`/`stop`; stream-hub, which already has the video, records it. The database gets the clip key it will use. `clips.py` is no longer in `app/camera_service/` | Avoids decoding and storing every camera's video twice |
| **Snapshots are stored by stream-hub** | `SnapshotStore` saved the JPEG locally and the backend read it from ml-service | The JPEG travels in a `snapshot` message and stream-hub stores it. Both sides compute the file name with `results.snapshot_key` / `clip_key`. `SnapshotStore` is only for sources without stream-hub | Same reason; the file lives next to the clip |
| **The backend reads status from the database** | `GET` on ml-service | A row of `ml_status`, rewritten every 10 s by `app/stats.py` | The two services no longer talk to each other; an old `updated_at` means ml-service is down |
| **The newest frame wins** (`frame_buffer.py`) | Counters and the pending frame lived inside the pipeline | Own class, with the frame's PTS | A slow model never builds a backlog |
| **`TCP_NODELAY`** | Nagle's algorithm left on | Turned off on every connection | Video arrived in bursts, adding tens to hundreds of ms |
| **`main.py` split up** | One file of ~500 lines with module-level globals | A thin script plus `app/` modules and a `Runtime` object (see the file reference) | Each part can be read, changed and tested alone |
| **`IncidentReporter`** (`incident_reporter.py`) | The pipeline knew about every output | One class turns an incident event into database records and stream-hub messages | Nothing else needs to know that "started" also means "start a clip" |
| **Settings** | `viewer:` and `clips:` sections | Removed. `handshake.tenant_in_handshake` is `true` in the shipped file, because stream-hub does send the tenant | See [CONFIG.md](CONFIG.md#removed-settings) |

#### 2. The detection improvements

Written up, with the benchmark numbers for each step, in
[DETECTION_CHANGELOG.md](DETECTION_CHANGELOG.md). In short:

| Change | What it does |
|---|---|
| **Fine-tuned pose model is the default** (`models/yolo26n-pose-finetuned-mcfDataset-111026.pt`) | Trained on the Multiple Cameras Fall Dataset (people on the floor, ceiling cameras). On the held-out test scenarios the falls caught per zone went from 1/6 to 5/6. The standard `yolo26n-pose.pt` is still in `models/`. |
| **Learned classifier, "Stage B"** (`fall.classifier: learned`) | A small model over the last second of body points. Catches 6/6 falls and alerts about 1 s sooner, but doubles the false alarms and reads a sofa as a fall, so it is an option, not the default |
| **`unclear` label** | Fewer than 6 visible body points, or no hips or legs: it says nothing instead of guessing |
| **Standing on straight legs is never lying** (`fall.standing_legs`) | Bending over no longer looks like a fall |
| **Most of the 3 seconds must show the person down** (`fall.confirm_ratio`) | Stray misdetections no longer add up to an alarm |
| **Fall speed in torso lengths per second** (`fall.fall_velocity` is now `1.2`, was `0.6` frame heights) | Near and far people are treated alike; the `falling` label appears in 31 of 35 falls (was 0) |
| **A renumbered person keeps their fall** (`fall.handoff_seconds`) | The tracker often renumbers someone as they fall; their 3-second timer used to restart |
| **Low-score tracking** (`inference.track_conf`) | A person reported at `conf` stays tracked down to `track_conf`, so someone isn't lost just as they fall |
| **`FallDetector`** | One object with the whole decision, used by the live service and the benchmark, replacing `fall/features.py`, `rules.py`, `state_machine.py` |
| **`evaluation/`, `model_finetuning/`, `models/`** | The benchmark, the training code with its report, and the model files |

#### 3. Where the old files went

| Before | Now |
|---|---|
| `ingest/protocol.py` + `ingest/decoder.py` | `app/camera_service/video_input.py` |
| `ingest/server.py` | `app/camera_service/hub_server.py` |
| `ingest/results.py` | `app/camera_service/hub_results.py` |
| `ingest/buffer.py` | `app/camera_service/frame_buffer.py` |
| `reporting.py` | `app/camera_service/incident_reporter.py` |
| `pipeline.py` + `fall/zones.py` | `app/camera_service/camera_pipeline.py` (part 1 and part 2) |
| `sinks/__init__.py` + `sinks/jsonl.py` | `app/camera_service/results.py` |
| `sinks/postgres.py` | `app/camera_service/database.py` |
| `fall/features.py`, `rules.py`, `state_machine.py` | `app/detection/fall_detection.py` |
| `vision/pose.py`, `vision/overlay.py` | `app/detection/pose_model.py`, `app/detection/overlay.py` |
| `compat/lap.py` | `app/detection/lap_compat/lap.py` |
| `config.py` | `app/config.py` |
| `clips.py` | removed: stream-hub records the clips now |
| `viewer.py` | `app/camera_service/viewer.py` (unused) |
| `tools/send_video.py`, `publish_webcam.py` | `setup_and_tools/fake_cameras/` |
| `tests/` | `setup_and_tools/tests/` |
| `Dockerfile`, `deploy/docker-compose.yml` | `setup_and_tools/docker_server/` |

Outside `ml-service`, the backend no longer calls ml-service over HTTP: it reads `ml_status`
from the database.

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

A person is reported once detected with confidence `inference.conf` (0.4). After that they
stay tracked down to `inference.track_conf` (0.1), because people lying on the floor get
lower scores than people standing, and we must not lose someone just as they fall.

### 2. Measurements (`app/detection/fall_detection.py`, section 1)

| Measurement | How it is computed | What it tells us |
|---|---|---|
| Torso angle | Angle between the shoulder midpoint → hip midpoint line and vertical. Without shoulders or hips: head/shoulders → hips/knees/ankles instead | 0° = upright, 90° = horizontal |
| Aspect ratio | Box width ÷ box height. Ignored when the box touches the frame edge (the person is cut off) | Above 1 means wider than tall, typical of lying |
| Legs upright | How far the ankles are below the hips, ÷ the leg's length along hip → knee → ankle | ~1 standing or bending over, ~0.5 sitting on a chair, ~0 lying |
| Hip drop speed | Straight-line fit of the hip height over the last 0.5 s, ÷ the person's torso length | Fast downward motion = a fall in progress. In body lengths, so near and far people are treated alike |
| Head below hips | Nose lower in the image than the hip midpoint | Strong hint the person is on the floor |
| Visible points | Keypoints at or above `min_keypoint_conf` | Too few = not enough to decide |

### 3. Labels (`app/detection/fall_detection.py`, sections 2-3)

Each person in each frame gets exactly one label and a confidence between 0 and 1.

| Label | Meaning | Preview colour |
|---|---|---|
| `upright` | Standing, walking, sitting, bending: not on the way down and not lying | green |
| `falling` | Going down fast right now | orange |
| `lying` | On the floor, or horizontal | red |
| `unclear` | Too little of the person is visible to tell. | grey |

The rules are checked in this order:

1. **Enough evidence?** Fewer than `min_visible_keypoints` (6) visible points, or no hip, knee
   or ankle at all (e.g. someone sitting behind a table), gives **`unclear`**. The box shape
   alone is never taken as proof of lying.
2. **Lying score.** Two scores from 0 to 1 are combined:
   - *angle score* rises from 0 at a 30° torso angle to 1 at `lying_torso_angle_deg` (60°)
   - *shape score* rises from 0 at aspect ratio 0.8 to 1 at `lying_aspect_ratio` (1.3)
   - lying score = 0.7 × angle score + 0.3 × shape score (angle score alone if the box touches
     the frame edge), plus 0.15 if the head is below the hips
   - **on their feet:** if *legs upright* is `standing_legs` (0.6) or more, the score is capped at
     0.5. Someone bent over on straight legs has a horizontal torso but isn't lying.

   If the lying score is **0.75 or more**, the label is **`lying`**, with the score as its confidence.
3. **Falling.** Otherwise, if the hips are dropping at **`fall_velocity` (1.2 torso lengths/s)
   or faster** and the torso is tilted **`falling_torso_angle_deg` (35°) or more**, the label is
   **`falling`**. Faster drops give higher confidence.
4. **Upright.** Anything else is **`upright`**, with confidence 1 − lying score.

**The learned classifier (optional, `fall.classifier: learned`).** Instead of the angles, a
small model (`models/stage_b.npz`, run in NumPy, no PyTorch needed) looks at the last second
of a person's body points and decides *down or not*; the rules still supply `falling` while
the person is going down. With fewer than `learned_min_keypoints` visible points it says
`unclear`. It must be trained on the same pose model that is running
(`python -m model_finetuning.finetune stage-b`). On the held-out test scenarios it caught
every fall but doubled the false alarms, so it stays off by default; the numbers are in
[DETECTION_CHANGELOG.md](DETECTION_CHANGELOG.md).

### 4. Decisions: incidents (`app/detection/fall_detection.py`, section 4)

Each tracked person has a small state machine. Being *down* means the label is `falling` or
`lying`. An `unclear` frame changes nothing: it neither confirms nor recovers.

| Event | Triggered when | What happens |
|---|---|---|
| `incident_started` | The person has been down for `confirm_seconds` (3 s), **at least `confirm_ratio` (80%) of their frames in those 3 s were down**, and the current label is `lying` | A new incident opens with severity `medium`. Its start time is backdated to when the fall began (the first frame of the mostly-down run, so a stray frame earlier is skipped). The current frame is saved as a snapshot |
| `incident_updated` | The incident has lasted `high_after_seconds` (60 s), then `critical_after_seconds` (300 s) | Severity goes up to `high`, then `critical`. Highest confidence seen so far is kept as `peak_confidence` |
| `incident_recovered` | The person has been `upright` for `recover_seconds` (3 s) | The incident closes with status `recovered`. `recovered_at` is set to the first upright frame, so the database can work out how long they were down |
| `incident_unresolved` | The person hasn't been seen for `lost_track_seconds` (10 s) while an incident is open | The incident closes with status `unresolved`. This needs a human check, because the person may still be on the floor out of view |

**Renumbered people.** Trackers often give someone a new ID as they fall, because their box
suddenly changes shape. A new ID that appears near where a person was lost within
`handoff_seconds` (2 s) takes over that person's state, so the 3-second timer doesn't restart
and an open incident stays with them.

What this filters out:

- **Bending over, crouching or sitting down quickly** may produce `falling` or `lying` for a
  moment. It only becomes an incident if it lasts 3 seconds, and bending on straight legs is
  never `lying` at all.
- **A `falling` label alone never opens an incident.** The person has to end up `lying`.
- **Stray misdetected frames** don't add up to an alarm: 80% of the frames in the 3 s must agree.
- **One misdetected frame** doesn't close an incident either. Recovery needs 3 seconds of `upright`.

A camera that disconnects with an incident still open closes it as `unresolved`.

**Measuring changes:** `python -m evaluation.evaluate` scores the logic on scripted scenarios and
recorded videos; [DETECTION_CHANGELOG.md](DETECTION_CHANGELOG.md) records each change and
what it did to the numbers.

### 5. Zones: one alert per fall across overlapping cameras (`app/camera_service/camera_pipeline.py`, part 2)

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
([CONFIG.md → output](CONFIG.md#output)), and, for a stream-hub camera, to stream-hub as
well. Both are done by `incident_reporter.py`.

**PostgreSQL** (`postgres` sink, the backend-module database; schema changes and details in
[backend-module/db/README.md](../backend-module/db/README.md)):

| Table | Written when |
|---|---|
| `incidents` | A fall is confirmed (insert); severity rises, a camera joins, or it closes (update) |
| `incident_cameras` | Each camera and tracked person that saw the incident, with its snapshot key and its clip key (the name stream-hub will save the clip under, written when the camera's incident ends) |
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
| `clips.jsonl` | When a **stream-hub** camera's incident ends (recovered or unresolved) | Incident, camera, and the clip key stream-hub will save the clip under. Not written for webcam/RTSP/file sources, which have no clips |
| `snapshots/` | A webcam, RTSP or file source confirms a fall | The JPEG itself. A stream-hub camera's snapshot is sent to stream-hub instead |

**stream-hub** (a separate Go service, on the camera's own connection): the four messages
described in [How ml-service and stream-hub talk](#how-ml-service-and-stream-hub-talk).

This is why clips and stream-hub-stored snapshots only exist for cameras that come through
stream-hub: a webcam, RTSP or file source has no such connection, so `incident_reporter.py`
saves the snapshot locally (`SnapshotStore`, under `data/snapshots/`) and never asks for a
clip.

Each incident event is also logged, e.g. `incident_started zone=... cameras=... severity=medium`,
and the preview window (`app/detection/overlay.py`) draws every person's box with
`#<track> <label> <confidence>`.

## Configuration

All settings live in `config.yaml`; [CONFIG.md](CONFIG.md) lists every option with its
default. The ones to tune first:

- `fall.confirm_seconds`: how long someone must stay down before an incident opens
- `fall.lying_torso_angle_deg`: torso angle from vertical that counts as lying
- `inference.weights`: which pose model to run
- `inference.conf`: how sure the model must be before a person is reported. Also changeable
  from the frontend's Detection Settings page, which wins over the file
- `inference.device`: `auto` (default) uses GPU 0 when CUDA is available and the CPU otherwise.
  A GPU index on a machine without CUDA falls back to the CPU with a warning. The startup log
  shows which one was picked: `model yolo26n-pose-finetuned-… ready on GPU 0 (...)`.
- `inference.half`: FP16 on GPU (sent to Ultralytics as `quantize=16`). Off by default.

## Deployment (Linux server container)

Production runs in a container on the on-prem Linux server with an NVIDIA GPU. It uses the
same `config.yaml` in prod mode (`ML_PROD_MODE=true`): stream-hub cameras, no preview,
listening on `0.0.0.0:9999` — the only port it exposes; there is no HTTP server here any
more (see [What changed](#what-changed-in-this-version)).

| File | Purpose |
|---|---|
| `setup_and_tools/docker_server/Dockerfile` | Python 3.15 image with PyTorch (CUDA 13.0 by default) and the model weights baked in |
| `setup_and_tools/docker_server/docker-compose.yml` | Runs the container with the GPU, port 9999 and a `ml-data` volume |
| `setup_and_tools/docker_server/.env.example` | The `ML_DATABASE_URL` to copy into `.env` |

The whole stack (database, gateway, stream-hub, backend, frontend and ml-service) is started
by the compose files in the repository root; `docker-compose.cpu.yml` there builds ml-service
with the CPU PyTorch for machines without an NVIDIA GPU.

**Host requirements:** NVIDIA driver 580+ (for CUDA 13.0) and the NVIDIA Container Toolkit.
Check with `docker run --rm --gpus all ubuntu nvidia-smi`.

```bash
# 1. The database (creates the shared "fallguard" Docker network)
cd backend-module
cp .env.example .env                   # set POSTGRES_PASSWORD, ML_SERVICE_PASSWORD
docker compose up -d

# 2. ml-service (joins the network, reaches the database as db:5432)
cd ../ml-service/setup_and_tools/docker_server
cp .env.example .env                   # ML_DATABASE_URL with the ML_SERVICE_PASSWORD
docker compose up -d --build
docker compose logs -f ml-service      # look for: model ... ready on GPU 0 (<server GPU>)
                                       #           database connected
```

Then point stream-hub at it: `ai_server_addr` in `stream-hub/config.json` = `<server>:9999`.
Details of the database setup: [backend-module/db/README.md](../backend-module/db/README.md).

How the image differs from the dev setup:

- **No workarounds needed.** The build stage has a C compiler, so the real PyYAML and `lap`
  are built and `app/detection/lap_compat/lap.py` stays unused.
- **Works offline.** The weights are baked in at build time: a file in `models/` is copied,
  a standard name such as `yolo26s-pose.pt` is downloaded (`--build-arg YOLO_WEIGHTS=...`).
  The build also runs the tracker once, so a missing package fails the build instead of
  Ultralytics trying to `pip install` it on the server. Ultralytics' usage analytics are
  turned off.
- **Checks the config.** The build fails if `config.yaml` isn't valid in prod mode (e.g. a
  webcam under `prod:`), or if `prod:` expects different weights from the baked-in ones.
  So `YOLO_WEIGHTS` (in the Dockerfile and in `docker-compose.yml`) and
  `inference.weights` must name the same model.
- **Runs as a non-root user**, with results in the `ml-data` volume (`/app/data`).
- **No preview window.** It turns off automatically when there is no display.

To change sources or thresholds without rebuilding, mount your own `config.yaml` over
`/app/config.yaml` (commented example in `setup_and_tools/docker_server/docker-compose.yml`).

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
   still enough to detect falls. Note that the web app then gets about 5 detections per
   second to draw on 25–30 video frames.
3. **Bigger model** (`yolo26s-pose.pt`, `yolo26m-pose.pt`) if the GPU has headroom; it
   detects people more reliably.
4. **`inference.half: true` (FP16)**: compare first; it was slower on the laptop (58 vs 40 ms).
5. **Next code steps for many cameras** (not built yet): batch all cameras' frames into one
   model call, and move H.264 decoding into separate processes so it doesn't compete with
   the model loop.

## Threading

PyTorch 2.14 on Python 3.15 crashes the process if a tensor is created on any thread
other than the main one. So the design is:

- **One thread per stream-hub connection** (`hub_server.py`) reads and decodes video and calls
  `CameraPipeline.handle_nalu`. It only decodes and hands over the newest frame
  (`CameraPipeline.submit`); it never touches PyTorch.
- **The main thread** (`loop.py`) runs the model for every camera in turn
  (`CameraPipeline.step`), always on each camera's newest frame. Keep any new PyTorch code
  on the main thread.
- **One writer thread per stream-hub connection** (`ResultWriter` in `hub_results.py`) sends
  the results back, so a slow or stuck stream-hub can't hold up inference.
- **One database thread** (`PostgresSink`) writes records. Two small threads in `main.py`'s
  start-up refresh zones and settings from the database (every 15 s) and write the `ml_status`
  row (every 10 s).

This was seen on Windows. It may not happen on Linux or with a newer PyTorch, but the
design works either way.

## Tests

```bash
python -m pytest
```

`pytest.ini` points it at `setup_and_tools/tests/`, one file per module:

| File | Covers |
|---|---|
| `test_fall_detection.py` | The measurements, rules, incident timing and `FallDetector` |
| `test_camera_pipeline.py` | One camera from frames to incidents, and the zones |
| `test_video_input.py` | The protocol, the decoder and the frame sampler |
| `test_stream_hub.py` | The stream-hub side: PTS on the wire, the decoder's PTS handling, the frame buffer, the result messages and their writer, the reporter, the TCP server, and the pipeline wired to all of them. Uses a stub pose model and a socket, so it needs no GPU or stream-hub |
| `test_config.py` | `config.yaml` loading, both modes, and the start-up checks |
| `test_database.py` | The PostgreSQL sink. Skipped unless `ML_TEST_DATABASE_URL` is set (see [CONFIG.md → environment variables](CONFIG.md#environment-variables)); it runs the real pipeline against a database loaded with `backend-module/db/schema.sql` + `seed.sql` |
| `test_pose_model.py` | The pose model wrapper and the `lap` stand-in. Needs `ultralytics` installed |
| `test_evaluation.py`, `test_model_finetuning.py` | The benchmark and its datasets · the training code and the learned classifier |
| `test_viewer.py` | The unused `viewer.py`. It stays green on purpose; delete it together with the file if that is ever removed |
| `test_clips.py` | Written for the old clip recorder, `clips.py`, which is not in this tree: it fails at import until `clips.py` is restored or the test is deleted |

## Known gaps

- Snapshots and clips stored by stream-hub have no local fallback: if stream-hub's disk is
  unreachable or its recordings volume fills up, that photo or clip is simply lost (the
  database record still exists; only the file doesn't). Model predictions and incident
  records don't have this problem, because this service also writes them to local JSONL.
- **No authentication.** Neither stream-hub's camera connection (port 9999) nor its
  WebSocket to the frontend check who is connecting; both should stay on the internal
  network until this is addressed.
- `viewer.py` is dead code kept on purpose; it should go once nobody needs the old
  behaviour back. `test_clips.py` is left over from the removed `clips.py`.
- gateway-back cameras live in gateway-back's own SQLite database and aren't registered in
  the backend `cameras` table, so their incidents have no camera name, location or DB zone
  until they are.
- Monthly partitions need a scheduled `create_monthly_partitions()` job run by the table
  owner (see [backend-module/db/README.md](../backend-module/db/README.md)).
- Stage B is kept as an option (`fall.classifier: learned`) but over-fits and reads sofas as
  falls; it needs training data with sitting and sofas, and a threshold tuned on false alarms.
- Cross-camera identity: zones stop duplicate alerts, but track IDs are still per camera.
  Telling two people apart across cameras would need a shared floor plan (camera
  calibration), not built yet.
- Throughput beyond ~4–6 cameras per machine needs batched inference and out-of-process
  decoding (see [Capacity and performance](#capacity-and-performance)).

Ultralytics YOLO is licensed AGPL-3.0.