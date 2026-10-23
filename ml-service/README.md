# ML Service — Fall Detection

Watches camera video (from **stream-hub**, a local webcam or a video file), finds people
with a **YOLO26 pose** model, and opens a fall incident when someone goes down and stays down.

Replaces `mock/receiver.py` (kept as a reference) and speaks the same TCP protocol
on port `9999` (`ai_server_addr` in `stream-hub/config.json`).

## Pipeline (per camera)

```
H.264 NALUs ─► decode (PyAV) ─► sample 10 fps ─► YOLO26-pose + ByteTrack
   ─► pose features ─► fall rules ─► incident state machine ─► data/*.jsonl
```

| Step | File | What it does |
|---|---|---|
| Protocol | `ingest/protocol.py` | Length-prefixed handshake and NALUs, read without partial-read bugs |
| Decode | `ingest/decoder.py` | One H.264 decoder per camera, frame-rate sampler |
| Pose | `vision/pose.py` | People, 17 COCO keypoints, stable track IDs |
| Features | `fall/features.py` | Torso angle, box aspect ratio, hip height, head below hips |
| Rules | `fall/rules.py` | Labels each pose `upright`, `falling` or `lying` (Stage A, no training needed) |
| Incidents | `fall/state_machine.py` | Down for `confirm_seconds` opens an incident; up for `recover_seconds` closes it |
| Output | `sinks/jsonl.py` | `model_predictions.jsonl`, `incidents.jsonl`, snapshots; fields match `backend-module/db/schema.sql` |

## How fall detection works

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

Not done yet: no alerts or notifications are sent, and nothing is written to the database or
shown in the frontend. See [Known gaps](#known-gaps).

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

## Run

Where the video comes from is set by `source.type` in `config.yaml`:

| `source.type` | Video from | Use for |
|---|---|---|
| `webcam` | a camera plugged into this PC (`webcam_index`) | quick testing, no Go services needed |
| `file` | a local video (`path`) | replaying recorded falls |
| `tcp` | stream-hub on port 9999 | the real pipeline: `gateway-back` → `stream-hub` → `ml-service` |

With `preview: true` a window shows the annotated video, so the VS Code Run button is enough.
Command-line flags override the file:

```powershell
python main.py                    # whatever config.yaml says
python main.py --webcam 0         # this PC's first webcam
python main.py --video fall.mp4   # a video file
python main.py --tcp              # stream-hub
python main.py --no-show          # no preview window
```

Wait for `model ... ready` in the log (about 5 s), then step into view.
Results go to `data/` (git-ignored). Press `q` in the window to quit.

To test the TCP path without the Go services, `tools/send_video.py --source 0` plays the
part of stream-hub.

## Tests

```powershell
python -m pytest
```

## Configuration

All thresholds live in `config.yaml`. The ones to tune first:

- `fall.confirm_seconds`: how long someone must stay down before an incident opens
- `fall.lying_torso_angle_deg`: torso angle from vertical that counts as lying
- `inference.weights`: `yolo26n-pose.pt` (fast) → `yolo26s-pose.pt` / `yolo26m-pose.pt` (more accurate)

## Threading

PyTorch 2.14 on Python 3.15 crashes the process if a tensor is created on any thread
other than the main one. So camera and connection threads only read and decode frames
(`CameraPipeline.submit`), and the main thread runs the model for every camera in turn
(`CameraPipeline.step`), always on each camera's newest frame. Keep any new PyTorch code
on the main thread.

## Known gaps

- stream-hub's `ai_worker.go` sends only `camera_id`, so `tenant_id` comes from
  `handshake.default_tenant_id`. Set `tenant_in_handshake: true` once the hub sends it.
- stream-hub drops NALUs when the AI buffer is full, which corrupts decoding until the
  next keyframe. It should drop up to the next keyframe instead.
- Results are written to local files. Sending them to `backend-module` is the next step.
- Stage B (a learned classifier over keypoint sequences, trained on public fall datasets)
  should replace `RuleClassifier` behind the same `classify()` interface.

Ultralytics YOLO is licensed AGPL-3.0.
