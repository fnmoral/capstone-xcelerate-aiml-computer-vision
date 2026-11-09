# Fall detection changelog

Every change to how falls are detected, why we made it, and what it did to the benchmark
numbers. Newest first.

The version is `RuleClassifier.version` in `fall/rules.py`. It is stored with every
prediction (`model_predictions.model_version`), so any stored result can be traced back to
the logic that produced it.

## How we measure

```powershell
cd ml-service
.venv\Scripts\python -m eval.benchmark --compare 06-keep-low-conf-tracks   # compare with the latest saved run
.venv\Scripts\python -m eval.benchmark --save 07-my-change                # keep a new run in eval/results/
```

The benchmark ([eval/benchmark.py](eval/benchmark.py)) runs the same `FallDetector` the live
service uses, with the settings in `config.yaml`, on two kinds of input:

- **20 synthetic scenarios** ([eval/scenarios.py](eval/scenarios.py)), each run with 5 random
  seeds. They are scripted body-point sequences: 8 falls, and 12 everyday activities that can
  look like a fall (bending over, sitting down fast, squatting, sitting at a table, detector
  glitches...). They're fast and repeatable and need no GPU, but they test the *logic* only, not
  the model's eyesight.
- **Recorded videos** listed in [eval/videos.yaml](eval/videos.yaml), with the real YOLO model
  and tracker. We have only two so far (`test-media/fall.mp4`, where the fall is staged by
  rotating the picture, and `test.mp4`, which has no fall).
- **Multiple Cameras Fall Dataset** (optional, 3.6 GB, not in the repo; see
  [eval/mcfd.py](eval/mcfd.py)): 24 scenarios × 8 ceiling cameras, one actor, 25 falls, plus
  sitting, crouching and lying on a sofa. Scored per camera and per zone (the chosen cameras
  run through the real incident aggregator, so we also see whether one fall gives one alert).
  Download it from
  [Kaggle](https://www.kaggle.com/datasets/soumicksarker/multiple-cameras-fall-dataset), keep it
  outside the repo and outside OneDrive, and run:

  ```powershell
  .venv\Scripts\python -m eval.benchmark --mcfd "C:\datasets\Fall Dataset"          # cameras 3,5,8
  .venv\Scripts\python -m eval.benchmark --mcfd "..." --mcfd-cameras 1-8 --mcfd-scenarios 1-5
  ```

  The first run takes about half an hour on a CPU (3 cameras); after that the model output
  is cached. Falls where the actor stays down for less than `confirm_seconds` + 0.5 s are
  reported as "short falls", not as misses, because the system is designed to wait that long.

What the numbers mean:

| Metric | Meaning | Better |
|---|---|---|
| Falls caught | Falls that raised an incident | higher |
| False alarms | Incidents with no fall | lower |
| Time to alert | Seconds from the fall to the incident (3 s of it is the deliberate `confirm_seconds` wait) | lower |
| Error in recorded fall start | How far the incident's `started_at` is from the real fall | lower |
| 'falling' label shown | Falls where the orange `falling` label appeared while going down | higher |
| Known-limit scenarios | Cases we *know* fail until a planned feature exists (listed below) | higher |

`tests/test_benchmark.py` runs the synthetic part with every `pytest`, so a change that misses
a fall or adds a false alarm fails the tests.

---

## 0.2.0 (2026-11-09): fewer false alarms, steadier tracking

### Overall result

| Metric | Before (0.1.0) | After (0.2.0) |
|---|---|---|
| Synthetic falls caught | 35/35 | 35/35 |
| Synthetic false alarms | **18** | **0** |
| Everyday scenarios with a false alarm | 4 of 10 | 0 of 10 |
| Mean time to alert | 3.87 s | 3.34 s |
| Error in recorded fall start | 0.80 s | 0.30 s |
| 'falling' label shown during the fall | 0/35 | 31/35 |
| Video falls caught / false alarms | 1/1, 0 | 1/1, 0 |

Results of every step are in [eval/results/](eval/results/) (`00-baseline.json` to
`06-keep-low-conf-tracks.json`).

### 6. Keep tracking people whose detection score drops

- **What:** a person is still *reported* once the model is 40% sure (`inference.conf`), but once
  reported they stay *tracked* down to 10% (`inference.track_conf`, new).
- **Why:** the model learned mostly from people standing up, so it's less sure about someone
  lying on the floor. Before, a fallen person whose score dipped under 0.4 just vanished, and the
  3-second confirmation started over each time they reappeared. Also, Ultralytics removed those
  weak detections *before* the tracker saw them, so the tracker's own "recover weak matches"
  step never had anything to work with.
- **Result:** no change on the benchmark: the synthetic scenarios don't run the model, and in our
  two videos the person's score never drops below 0.66. **Not yet verified**: needs footage
  of a real fall, ideally a dim room or an unusual angle.
- **Files:** `vision/pose.py`, `config.py`, `config.yaml`

### 5. A renumbered person keeps their fall

- **What:** when a new track ID appears close to where someone was lost in the last 2 s
  (`fall.handoff_seconds`, new), it takes over that person's state and any open incident.
- **Why:** a falling person's box suddenly changes from tall to wide, and the tracker often
  thinks it's a new person. Each new ID restarted the 3-second timer, delaying or even
  preventing the alert.
- **Result:** the `fall_id_switch` scenario (renumbered three times while lying) alerted after
  6.3 s on average, now 3.3 s, the same as a normal fall. Mean time to alert 3.77 → 3.34 s;
  error in recorded fall start 0.71 → 0.30 s.
- **Files:** `fall/detector.py`, `fall/state_machine.py`

### 4. Measure fall speed in body lengths, not screen size

- **What:** hip drop speed is now in the person's own **torso lengths per second**
  (`fall.fall_velocity: 1.2`, was `0.6` frame heights per second). It is a straight-line fit
  over the last 0.5 s instead of first-vs-last of 8 samples.
- **Why:** in screen units, someone near the camera moves many pixels when they fall and
  someone far away moves very few, so falls far from the camera never counted as fast. In our
  scripted falls, even a person close to the camera stayed under the old threshold. A fit over
  several points is also less jumpy than comparing two single points.
- **Result:** the `falling` label now appears in 31 of 35 falls (was 0). Alerts arrive 0.1 s
  sooner and the recorded fall start is 0.1 s more accurate, because the orange frames count
  as the start of the fall. A first try with a 1 s window reached only 2/35 because it reacted
  too late: by the time the speed was measured, the person was already lying.
- **Not done:** smoothing each body point over time. The fit already smooths the speed, and
  smoothing the points adds lag; worth revisiting with real noisy footage.
- **Files:** `fall/detector.py` (speed moved here from `state_machine.py`), `fall/rules.py`,
  `config.yaml`. The frontend's Detection Settings page shows the new unit.

### 3. Don't guess from too little evidence: the new `unclear` label

- **What:** a person with fewer than 6 visible body points (`fall.min_visible_keypoints`, new),
  or with no hip, knee or ankle visible at all, gets the new label **`unclear`** (grey). It
  neither confirms a fall nor recovers one. Also: when shoulders or hips are missing, the body
  angle uses head-to-legs instead, and a box touching the frame edge no longer counts as "wide".
- **Why:** before, when the torso couldn't be seen, the box shape alone decided. Someone sitting
  at a table with arms spread has a wide box (only the upper body shows) and was labelled
  `lying`, so after 3 s it became an alarm. A person cut off by the frame edge has a misleading box
  too.
- **Result:** the `at_table` false alarm is gone (5 → 0). No falls lost.
- **Files:** `fall/features.py`, `fall/rules.py`, `fall/state_machine.py`, `pipeline.py` (grey box);
  frontend `CameraGrid.tsx` now counts only `lying`/`falling` as down; badges and legends show
  `Unclear`.

### 2. Standing on straight legs is never lying

- **What:** a new measurement, *legs upright*: how far the ankles are below the hips, divided by
  the leg's length. About 1 when standing or bending over, about 0.5 sitting on a chair, about
  0 lying. At 0.6 or more (`fall.standing_legs`, new), the person can't be labelled `lying`.
- **Why:** the old rule looked mainly at the torso. Someone bending over to tie their shoes or
  make a bed has a horizontal torso, so they scored as `lying`, and if they stayed bent for
  3 s, that was an alarm. Legs tell the difference: a bent-over person still stands on them.
- **Result:** both bending scenarios went from a false alarm every time (5/5 and 5/5) to none.
  No falls lost.
- **Files:** `fall/features.py`, `fall/rules.py`

### 1. Most of the 3 seconds must actually show the person down

- **What:** an incident now needs the person down for 3 s **and** in at least 80% of the
  frames in those 3 s (`fall.confirm_ratio`, new). The recorded fall start skips stray frames
  from before the real fall.
- **Why:** the timer started at the first `lying` frame and only reset after 3 s of being
  upright. So one misdetected frame, then 2.9 s of normal standing, then a second misdetected
  frame was enough to raise an alarm.
- **Result:** the `detector_glitches` scenario had false alarms in 3 of 5 runs; now none.
  The "feet toward the camera" scenario was being caught 4/5 times only by that same flaw
  (stray frames adding up), so it now shows 0/5, which is its real state (see known limits).
- **Files:** `fall/state_machine.py`

### 0. Groundwork (no change in behaviour)

- Moved the per-person logic from `pipeline.py` into `fall/detector.py` (`FallDetector`),
  so the live service and the benchmark run exactly the same code.
- Added the benchmark (`eval/`) and recorded the baseline (`eval/results/00-baseline.json`).

---

## Known limits (still failing on purpose)

These scenarios are in the benchmark so we can see when they get fixed:

| Scenario | Why it fails | Planned fix |
|---|---|---|
| `lie_on_bed`: lies down slowly on a bed | Looks exactly like lying on the floor | Per-camera "bed/couch" areas drawn in the frontend, and/or requiring a fast drop before lying |
| `kneel_look_under`: kneels, torso flat, head low | Body is horizontal and knees are bent, so the legs check doesn't apply | Require a fast drop before lying, or a learned model (stage B) |
| `fall_toward_camera`: lies with feet toward the camera | The body looks short and upright in the picture | Compare the person's current height with their standing height, or more cameras per zone |

## Ideas not done yet

- **Fine-tune YOLO26-pose** on fall footage (people lying down, seen from above, IR at night).
- **Stage B:** a small learned model over ~2 s of body points, trained on `model_predictions`
  (keypoints are already stored once per second) and on staff feedback.
- **"Confirmed fall / false alarm" button** on incidents, to collect real labels.
- **More real videos** in `eval/videos.yaml`: this is what makes the benchmark trustworthy.
