# ML Service — Fall Detection

Receives camera streams from **stream-hub**, finds people with a **YOLO26 pose** model,
and opens a fall incident when someone goes down and stays down.

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

```powershell
python main.py --show                                 # start the service with a preview window
python tools/send_video.py --source 0                 # in a 2nd terminal: send your webcam
python tools/send_video.py --source fall.mp4 --loop   # or a video file
```

Or run the real chain: `gateway-back` → `stream-hub` → `ml-service`.

Results go to `data/` (git-ignored). Press `q` in the window to quit.

## Tests

```powershell
python -m pytest
```

## Configuration

All thresholds live in `config.yaml`. The ones to tune first:

- `fall.confirm_seconds`: how long someone must stay down before an incident opens
- `fall.lying_torso_angle_deg`: torso angle from vertical that counts as lying
- `inference.weights`: `yolo26n-pose.pt` (fast) → `yolo26s-pose.pt` / `yolo26m-pose.pt` (more accurate)

## Known gaps

- stream-hub's `ai_worker.go` sends only `camera_id`, so `tenant_id` comes from
  `handshake.default_tenant_id`. Set `tenant_in_handshake: true` once the hub sends it.
- stream-hub drops NALUs when the AI buffer is full, which corrupts decoding until the
  next keyframe. It should drop up to the next keyframe instead.
- Results are written to local files. Sending them to `backend-module` is the next step.
- Stage B (a learned classifier over keypoint sequences, trained on public fall datasets)
  should replace `RuleClassifier` behind the same `classify()` interface.

Ultralytics YOLO is licensed AGPL-3.0.
