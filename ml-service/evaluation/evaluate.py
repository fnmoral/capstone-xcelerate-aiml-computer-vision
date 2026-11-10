"""Fall-detection benchmark: measures how many falls are caught and how many false alarms are raised.

    python -m evaluation.evaluate                         # run and print the results
    python -m evaluation.evaluate --save 01-my-change     # also keep them in evaluation/results/01-my-change.json
    python -m evaluation.evaluate --compare 00-baseline   # show what changed against a saved run
    python -m evaluation.evaluate --no-video              # synthetic scenarios only (no model needed)
    python -m evaluation.evaluate --mcfd "C:/datasets/Fall Dataset"   # also the Multiple Cameras Fall Dataset

Three parts:
- Synthetic scenarios (evaluation/datasets.py): scripted keypoints for falls and for everyday things
  that look a bit like falls (bending, sitting, squatting...). Each runs with several random
  seeds. Fast, needs no model, and tests the fall logic on its own.
- Recorded videos (evaluation/videos.yaml): the real model and tracker on real footage. The model's
  output is cached in evaluation/.cache, so only a change to the model, tracker or detection/pose_model.py
  runs it again.
- Multiple Cameras Fall Dataset (evaluation/datasets.py, optional, 3.6 GB, not in the repo): 24 scenarios
  filmed by 8 cameras, with falls, sitting, crouching and lying on a sofa. Scored per camera
  and per zone (the chosen cameras grouped like a real zone, through the incident aggregator).

All parts feed the same FallDetector the live service uses, with the settings from config.yaml.
"""

import argparse
import hashlib
import json
import os
import pickle
import subprocess
import sys
import time
from dataclasses import asdict, replace
from pathlib import Path

import numpy as np
import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import config  # noqa: E402
from evaluation import datasets as mcfd  # noqa: E402
from evaluation.datasets import FRAME_H, FRAME_W, render, scenarios  # noqa: E402
from detection.fall_detection import FallDetector  # noqa: E402
from detection.fall_detection import FALLING, LYING, UNCLEAR  # noqa: E402
from detection.fall_detection import STARTED  # noqa: E402
from camera_service.camera_pipeline import IncidentAggregator  # noqa: E402

EVAL = Path(__file__).resolve().parent
RESULTS = EVAL / "results"
CACHE = EVAL / ".cache"
SEEDS = 5
EARLY_TOLERANCE_S = 0.5   # an alert this much before the ground-truth start still counts
DOWN = (LYING, FALLING)
MCFD_CAMERAS = "3,5,8"    # default: three cameras on different walls of the room
MCFD_MARGIN_S = 0.5       # a fall "should alert" if the person stays down confirm_seconds + this


def replay(cfg: config.Config, frames, frame_shape,
           events_out: list | None = None) -> tuple[list[tuple[float, float]], list[tuple[float, str]]]:
    """Feed frames of (time, people) to a fresh detector.

    Returns the alerts as (alert time, incident start time) and every person-frame label as (time, label).
    Every incident event is also appended to events_out, if given.
    """
    det = FallDetector(cfg.rules, cfg.monitor, cfg.detector)
    alerts, labels = [], []
    for t, people in frames:
        results, events = det.process(t, people, frame_shape)
        events += det.expire(t)
        labels += [(t, r.label) for r in results]
        alerts += [(e.at, e.incident.started_at) for e in events if e.kind == STARTED]
        if events_out is not None:
            events_out += events
    return alerts, labels


def score(alerts, labels, falls: list[tuple[float, float]]) -> dict:
    """Match alerts to ground-truth falls. Unmatched alerts are false alarms."""
    def in_fall(t, early=0.0):
        return any(a - early <= t <= b for a, b in falls)

    caught, tta, start_err, falling_seen = 0, [], [], 0
    for a, b in falls:
        falling_seen += any(lbl == FALLING for t, lbl in labels if a <= t <= a + 2.0)
        hits = sorted((t, s) for t, s in alerts if a - EARLY_TOLERANCE_S <= t <= b)
        if hits:
            caught += 1
            tta.append(hits[0][0] - a)
            start_err.append(abs(hits[0][1] - a))
    false_alarms = sum(not in_fall(t, EARLY_TOLERANCE_S) for t, _ in alerts)
    outside = [lbl for t, lbl in labels if not in_fall(t, 1.0)]
    return {
        "falls": len(falls),
        "caught": caught,
        "time_to_alert_s": tta,
        "start_error_s": start_err,
        "falling_seen": falling_seen,
        "false_alarms": false_alarms,
        "wrong_down_frames": sum(lbl in DOWN for lbl in outside),
        "frames_outside_falls": len(outside),
    }


# --------------------------------------------------------------------------- synthetic

def run_synthetic(cfg: config.Config) -> dict:
    out = {}
    for sc in scenarios():
        runs = []
        for seed in range(SEEDS):
            frames = render(sc, seed)
            falls = []
            if sc.fall_at is not None:
                # Down until the last lying frame of the script; generous end, it only bounds matching.
                falls = [(sc.fall_at, frames[-1][0] + 1)]
            alerts, labels = replay(cfg, frames, (FRAME_H, FRAME_W, 3))
            runs.append(score(alerts, labels, falls))
        out[sc.name] = {
            "description": sc.description,
            "fall": sc.fall_at is not None,
            "known_limit": sc.known_limit,
            "runs": len(runs),
            "caught": sum(r["caught"] for r in runs),
            "falls": sum(r["falls"] for r in runs),
            "false_alarms": sum(r["false_alarms"] for r in runs),
            "time_to_alert_s": _mean([x for r in runs for x in r["time_to_alert_s"]]),
            "start_error_s": _mean([x for r in runs for x in r["start_error_s"]]),
            "falling_seen": sum(r["falling_seen"] for r in runs),
            "wrong_down_pct": _pct(sum(r["wrong_down_frames"] for r in runs),
                                   sum(r["frames_outside_falls"] for r in runs)),
        }
    return out


# --------------------------------------------------------------------------- videos

def _fingerprint(cfg: config.Config, video: Path, extra: str = "") -> str:
    import ultralytics
    inf = cfg.inference
    tracker = Path(inf.tracker)
    parts = [
        video.name, str(video.stat().st_size), str(int(video.stat().st_mtime)),
        Path(inf.weights).name, str(inf.imgsz), str(inf.conf), str(inf.target_fps),
        json.dumps(asdict(inf), sort_keys=True, default=str),
        tracker.read_text() if tracker.is_file() else inf.tracker,
        (ROOT / "detection" / "pose_model.py").read_text(encoding="utf-8"),
        ultralytics.__version__,
    ] + ([extra] if extra else [])
    return hashlib.sha256("\n".join(parts).encode()).hexdigest()[:16]


def detect_video(cfg: config.Config, video: Path, *, fps: float | None = None, offset_frames: int = 0,
                 start_s: float | None = None, end_s: float | None = None):
    """Run the pose tracker over a video at target_fps. Cached by everything that affects the output.

    Frame i is at time (i - offset_frames) / fps (fps defaults to the file's own). Only frames
    from start_s to end_s are analysed; the ones before are skipped without converting them.
    """
    CACHE.mkdir(exist_ok=True)
    custom = fps is not None or offset_frames or start_s is not None or end_s is not None
    extra = f"{fps},{offset_frames},{start_s},{end_s}" if custom else ""
    name = f"{video.parent.name}-{video.stem}" if custom else video.stem
    cached = CACHE / f"{name}-{_fingerprint(cfg, video, extra)}.pkl"
    if cached.exists():
        return pickle.loads(cached.read_bytes())

    import cv2
    from detection.pose_model import PoseTracker
    tracker = PoseTracker.from_config(cfg.inference)
    cap = cv2.VideoCapture(str(video))
    fps = fps or cap.get(cv2.CAP_PROP_FPS) or 25.0
    step = 1.0 / cfg.inference.target_fps
    frames, shape, i = [], None, 0
    next_t = start_s if start_s is not None else -offset_frames / fps
    started = time.perf_counter()
    while True:
        t = (i - offset_frames) / fps
        if end_s is not None and t > end_s:
            break
        if t + 1e-6 < next_t:
            if not cap.grab():
                break
            i += 1
            continue
        ok, frame = cap.read()
        if not ok:
            break
        i += 1
        next_t += step
        shape = frame.shape
        frames.append((t, tracker(frame)))
    cap.release()
    print(f"  {name}: ran the model on {len(frames)} frames in {time.perf_counter() - started:.0f} s",
          file=sys.stderr)
    data = (frames, shape)
    cached.write_bytes(pickle.dumps(data))
    return data


def run_videos(cfg: config.Config) -> dict:
    spec = yaml.safe_load((EVAL / "videos.yaml").read_text(encoding="utf-8"))
    out = {}
    for v in spec.get("videos", []):
        path = (EVAL / v["path"]).resolve()
        if not path.exists():
            print(f"  skipping {path.name}: file not found", file=sys.stderr)
            continue
        frames, shape = detect_video(cfg, path)
        falls = [tuple(f) for f in v.get("falls", [])]
        alerts, labels = replay(cfg, frames, shape)
        s = score(alerts, labels, falls)
        inside = [lbl for t, lbl in labels if any(a + 2.0 <= t <= b for a, b in falls)]
        out[path.name] = {
            "note": v.get("note", ""),
            "falls": s["falls"],
            "caught": s["caught"],
            "false_alarms": s["false_alarms"],
            "time_to_alert_s": _mean(s["time_to_alert_s"]),
            "start_error_s": _mean(s["start_error_s"]),
            "alerts": [[round(t, 2), round(st, 2)] for t, st in alerts],  # [alert time, incident start]
            "wrong_down_pct": _pct(s["wrong_down_frames"], s["frames_outside_falls"]),
            "down_during_fall_pct": _pct(sum(lbl in DOWN for lbl in inside), len(inside)),
        }
    return out


# --------------------------------------------------------------------------- Multiple Cameras Fall Dataset

def _new_tally() -> dict:
    return {"expected": 0, "caught": 0, "short": 0, "short_caught": 0, "duplicates": 0,
            "time_to_alert_s": [], "start_error_s": [], "false_alarms": {}}


def score_mcfd(scenario: int, alerts, need_s: float, tally: dict) -> dict:
    """Score one camera's (or one zone's) alerts for one scenario, adding to tally.

    A fall followed by at least need_s on the ground should raise an alert. A shorter one
    (the actor got up quickly) may or may not: it's counted separately, never as a miss.
    An alert matching no fall is a false alarm, filed under what the person was doing when the
    incident started.
    """
    used, row = set(), {"expected": 0, "caught": 0, "short": 0, "short_caught": 0, "false_alarms": 0}
    for f in mcfd.falls(scenario):
        hits = sorted((t, s) for t, s in alerts if f.start - EARLY_TOLERANCE_S <= t <= f.end + 1.0)
        used.update(hits)
        tally["duplicates"] += max(len(hits) - 1, 0)
        kind = "expected" if f.lying_s >= need_s else "short"
        row[kind] += 1
        if hits:
            row["caught" if kind == "expected" else "short_caught"] += 1
            if kind == "expected":
                tally["time_to_alert_s"].append(hits[0][0] - f.start)
                tally["start_error_s"].append(abs(hits[0][1] - f.start))
    for t, s in alerts:
        if (t, s) in used:
            continue
        what = mcfd.ACTIVITY.get(mcfd.activity_at(scenario, s), "unannotated")
        tally["false_alarms"][what] = tally["false_alarms"].get(what, 0) + 1
        row["false_alarms"] += 1
    for k in ("expected", "caught", "short", "short_caught"):
        tally[k] += row[k]
    return row


def _finish(tally: dict) -> dict:
    out = dict(tally)
    out["false_alarm_count"] = sum(tally["false_alarms"].values())
    out["time_to_alert_s"] = _mean(tally["time_to_alert_s"])
    out["start_error_s"] = _mean(tally["start_error_s"])
    return out


def run_mcfd(cfg: config.Config, root: Path, scenario_ids: list[int], cameras: list[int]) -> dict:
    need = cfg.monitor.confirm_seconds + MCFD_MARGIN_S
    cam_tally, zone_tally = _new_tally(), _new_tally()
    activity: dict[str, list[int]] = {}   # activity -> [person-frames, down, unclear]
    per_scenario = {}
    for s in scenario_ids:
        a, b = mcfd.annotated(s)
        row, cam_events = {}, []
        for c in cameras:
            path = mcfd.video_path(root, s, c)
            if not path.exists():
                print(f"  skipping {path}: not found", file=sys.stderr)
                continue
            frames, shape = detect_video(cfg, path, fps=mcfd.MCFD_FPS, offset_frames=mcfd.DELAYS[s][c - 1],
                                         start_s=max(a - 1.0, 0.0), end_s=b)
            events: list = []
            alerts, labels = replay(cfg, frames, shape, events)
            cam_events += [(e.at, i, c, e) for i, e in enumerate(events)]
            row[f"cam{c}"] = score_mcfd(s, alerts, need, cam_tally)
            for t, lbl in labels:
                what = mcfd.ACTIVITY.get(mcfd.activity_at(s, t), "unannotated")
                n = activity.setdefault(what, [0, 0, 0])
                n[0] += 1
                n[1] += lbl in DOWN
                n[2] += lbl == UNCLEAR
        # The same cameras as one zone, through the real aggregator: one fall should be one alert.
        agg = IncidentAggregator({"room": [f"cam{c}" for c in cameras]}, cfg.merge_window_s)
        zone_alerts = []
        for at, _, c, e in sorted(cam_events, key=lambda x: (x[0], x[1])):
            for kind, zi in agg.handle("mcfd", f"cam{c}", e):
                if kind == STARTED:
                    zone_alerts.append((at, zi.started_at))
        row["zone"] = score_mcfd(s, zone_alerts, need, zone_tally)
        per_scenario[str(s)] = row
    return {
        "cameras": cameras,
        "scenarios": scenario_ids,
        "need_down_s": need,
        "camera": _finish(cam_tally),
        "zone": _finish(zone_tally),
        "labels": {k: {"frames": n, "down_pct": _pct(d, n), "unclear_pct": _pct(u, n)}
                   for k, (n, d, u) in sorted(activity.items())},
        "per_scenario": per_scenario,
    }


def _scenario_text(s: int) -> str:
    other = []
    for _, _, code in mcfd.PERIODS[s]:
        name = {4: "crouch", 7: "sit", 8: "sofa"}.get(code)
        if name and name not in other:
            other.append(name)
    text = ", ".join(f"fall ({f.lying_s:.1f} s down)" for f in mcfd.falls(s)) or "no fall"
    return text + (f"; {', '.join(other)}" if other else "")


# --------------------------------------------------------------------------- summary & output

def _mean(xs):
    return round(float(np.mean(xs)), 2) if xs else None


def _pct(a, b):
    return round(100.0 * a / b, 1) if b else None


def summarize(synthetic: dict, videos: dict, mc: dict | None = None) -> dict:
    core = [s for s in synthetic.values() if not s["known_limit"]]
    pos = [s for s in core if s["fall"]]
    neg = [s for s in core if not s["fall"]]
    tta = [s["time_to_alert_s"] for s in pos if s["time_to_alert_s"] is not None]
    err = [s["start_error_s"] for s in pos if s["start_error_s"] is not None]
    return {
        "synthetic_falls_caught": f"{sum(s['caught'] for s in pos)}/{sum(s['falls'] for s in pos)}",
        "synthetic_recall_pct": _pct(sum(s["caught"] for s in pos), sum(s["falls"] for s in pos)),
        "synthetic_false_alarms": sum(s["false_alarms"] for s in core),
        "synthetic_false_alarm_scenarios": f"{sum(s['false_alarms'] > 0 for s in neg)}/{len(neg)}",
        "synthetic_time_to_alert_s": _mean(tta),
        "synthetic_start_error_s": _mean(err),
        "synthetic_falling_label_seen": f"{sum(s['falling_seen'] for s in pos)}/{sum(s['falls'] for s in pos)}",
        "known_limits_passed": f"{sum(_passed(s) for s in synthetic.values() if s['known_limit'])}"
                               f"/{sum(s['known_limit'] for s in synthetic.values())}",
        "video_falls_caught": f"{sum(v['caught'] for v in videos.values())}/{sum(v['falls'] for v in videos.values())}",
        "video_false_alarms": sum(v["false_alarms"] for v in videos.values()),
    } | (_summarize_mcfd(mc) if mc else {})


def _summarize_mcfd(mc: dict) -> dict:
    cam, zone = mc["camera"], mc["zone"]
    return {
        "mcfd_camera_falls_caught": f"{cam['caught']}/{cam['expected']}",
        "mcfd_camera_recall_pct": _pct(cam["caught"], cam["expected"]),
        "mcfd_camera_false_alarms": cam["false_alarm_count"],
        "mcfd_zone_falls_caught": f"{zone['caught']}/{zone['expected']}",
        "mcfd_zone_false_alarms": zone["false_alarm_count"],
        "mcfd_zone_duplicate_alerts": zone["duplicates"],
        "mcfd_zone_short_falls_caught": f"{zone['short_caught']}/{zone['short']}",
        "mcfd_time_to_alert_s": cam["time_to_alert_s"],
    }


def _passed(s: dict) -> bool:
    return s["caught"] == s["falls"] and s["false_alarms"] == 0


def git_commit() -> str:
    try:
        sha = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True,
                             text=True, check=True).stdout.strip()
        dirty = subprocess.run(["git", "status", "--porcelain", "--", "."], cwd=ROOT, capture_output=True,
                               text=True).stdout.strip()
        return sha + ("+uncommitted" if dirty else "")
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def settings(cfg: config.Config) -> dict:
    return {"rules": asdict(cfg.rules), "monitor": asdict(cfg.monitor), "detector": asdict(cfg.detector),
            "inference": {k: v for k, v in asdict(cfg.inference).items() if k != "weights"}
                         | {"weights": Path(cfg.inference.weights).name}}


def print_report(res: dict) -> None:
    print(f"\n## Benchmark: {res['name']}  ({res['date']}, {res['commit']})\n")
    s = res["summary"]
    print("| Summary | Value |\n|---|---|")
    print(f"| Synthetic falls caught | {s['synthetic_falls_caught']} ({s['synthetic_recall_pct']}%) |")
    print(f"| Synthetic false alarms | {s['synthetic_false_alarms']} "
          f"(in {s['synthetic_false_alarm_scenarios']} everyday scenarios) |")
    print(f"| Mean time to alert | {s['synthetic_time_to_alert_s']} s |")
    print(f"| Mean error in recorded fall start | {s['synthetic_start_error_s']} s |")
    print(f"| 'falling' label shown during the fall | {s.get('synthetic_falling_label_seen')} |")
    print(f"| Known-limit scenarios passed | {s['known_limits_passed']} |")
    print(f"| Video falls caught | {s['video_falls_caught']} |")
    print(f"| Video false alarms | {s['video_false_alarms']} |")

    print("\n| Scenario | Fall? | Caught | False alarms | Time to alert | Wrong 'down' frames |")
    print("|---|---|---|---|---|---|")
    for name, r in res["synthetic"].items():
        mark = " (known limit)" if r["known_limit"] else ""
        caught = f"{r['caught']}/{r['falls']}" if r["fall"] else "-"
        tta = f"{r['time_to_alert_s']} s" if r["time_to_alert_s"] is not None else "-"
        print(f"| {name}{mark} | {'yes' if r['fall'] else 'no'} | {caught} | {r['false_alarms']} | {tta} "
              f"| {r['wrong_down_pct']}% |")
    if res["videos"]:
        print("\n| Video | Caught | False alarms | Time to alert | Down during fall | Wrong 'down' frames |")
        print("|---|---|---|---|---|---|")
        for name, v in res["videos"].items():
            tta = f"{v['time_to_alert_s']} s" if v["time_to_alert_s"] is not None else "-"
            print(f"| {name} | {v['caught']}/{v['falls']} | {v['false_alarms']} | {tta} "
                  f"| {v['down_during_fall_pct'] if v['down_during_fall_pct'] is not None else '-'}% "
                  f"| {v['wrong_down_pct']}% |")
    if res.get("mcfd"):
        print_mcfd(res["mcfd"])


def print_mcfd(mc: dict) -> None:
    cams = ", ".join(str(c) for c in mc["cameras"])
    print(f"\n### Multiple Cameras Fall Dataset (cameras {cams}, {len(mc['scenarios'])} scenarios)\n")
    print(f"A fall should alert when the person stays down at least {mc['need_down_s']} s; shorter ones "
          "are counted on their own.\n")
    print("| | Each camera on its own | Cameras as one zone |\n|---|---|---|")
    c, z = mc["camera"], mc["zone"]
    print(f"| Falls caught | {c['caught']}/{c['expected']} ({_pct(c['caught'], c['expected'])}%) "
          f"| {z['caught']}/{z['expected']} ({_pct(z['caught'], z['expected'])}%) |")
    print(f"| Short falls caught | {c['short_caught']}/{c['short']} | {z['short_caught']}/{z['short']} |")
    print(f"| False alarms | {c['false_alarm_count']} | {z['false_alarm_count']} |")
    print(f"| Extra alerts for the same fall | {c['duplicates']} | {z['duplicates']} |")
    print(f"| Mean time to alert | {c['time_to_alert_s']} s | {z['time_to_alert_s']} s |")
    if c["false_alarms"]:
        print("\nFalse alarms by what the person was doing: "
              + ", ".join(f"{k} {v}" for k, v in sorted(c["false_alarms"].items(), key=lambda x: -x[1])))
    print("\n| Activity (ground truth) | Person-frames | Labelled down | Labelled unclear |\n|---|---|---|---|")
    for k, v in mc["labels"].items():
        print(f"| {k} | {v['frames']} | {v['down_pct']}% | {v['unclear_pct']}% |")
    head = " | ".join(f"cam{c}" for c in mc["cameras"])
    print(f"\n| Scenario | What happens | {head} | Zone |\n|---|---|" + "---|" * len(mc["cameras"]) + "---|")
    for s, row in mc["per_scenario"].items():
        cells = []
        for key in [f"cam{c}" for c in mc["cameras"]] + ["zone"]:
            r = row.get(key)
            if r is None:
                cells.append("n/a")
                continue
            text = f"{r['caught']}/{r['expected']}" if r["expected"] else "-"
            if r["short"]:
                text += f" (short {r['short_caught']}/{r['short']})"
            if r["false_alarms"]:
                text += f" **{r['false_alarms']} FA**"
            cells.append(text)
        print(f"| {s} | {_scenario_text(int(s))} | " + " | ".join(cells) + " |")


def print_compare(old: dict, new: dict) -> None:
    print(f"\n## Change: {old['name']} -> {new['name']}\n")
    print("| Metric | Before | After |\n|---|---|---|")
    for k, label in [("synthetic_falls_caught", "Synthetic falls caught"),
                     ("synthetic_false_alarms", "Synthetic false alarms"),
                     ("synthetic_false_alarm_scenarios", "Everyday scenarios with a false alarm"),
                     ("synthetic_time_to_alert_s", "Mean time to alert (s)"),
                     ("synthetic_start_error_s", "Mean error in recorded fall start (s)"),
                     ("synthetic_falling_label_seen", "'falling' label shown during the fall"),
                     ("known_limits_passed", "Known-limit scenarios passed"),
                     ("video_falls_caught", "Video falls caught"),
                     ("video_false_alarms", "Video false alarms"),
                     ("mcfd_camera_falls_caught", "MCFD falls caught (per camera)"),
                     ("mcfd_camera_false_alarms", "MCFD false alarms (per camera)"),
                     ("mcfd_zone_falls_caught", "MCFD falls caught (zone)"),
                     ("mcfd_zone_false_alarms", "MCFD false alarms (zone)"),
                     ("mcfd_zone_duplicate_alerts", "MCFD extra alerts for one fall (zone)"),
                     ("mcfd_zone_short_falls_caught", "MCFD short falls caught (zone)")]:
        if k.startswith("mcfd_") and k not in old["summary"] and k not in new["summary"]:
            continue
        a, b = old["summary"].get(k), new["summary"].get(k)
        print(f"| {label} | {a} | {b}{' **changed**' if a != b else ''} |")
    changed = []
    for name, r in new["synthetic"].items():
        o = old["synthetic"].get(name)
        if o and (o["caught"], o["false_alarms"]) != (r["caught"], r["false_alarms"]):
            changed.append(f"- {name}: caught {o['caught']}->{r['caught']}/{r['falls']}, "
                           f"false alarms {o['false_alarms']}->{r['false_alarms']}")
    for name, v in new["videos"].items():
        o = old["videos"].get(name)
        if o and (o["caught"], o["false_alarms"], o["wrong_down_pct"]) != (v["caught"], v["false_alarms"], v["wrong_down_pct"]):
            changed.append(f"- {name}: caught {o['caught']}->{v['caught']}/{v['falls']}, false alarms "
                           f"{o['false_alarms']}->{v['false_alarms']}, wrong 'down' frames "
                           f"{o['wrong_down_pct']}%->{v['wrong_down_pct']}%")
    if changed:
        print("\nScenarios that changed:\n" + "\n".join(changed))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default=str(ROOT / "config.yaml"))
    ap.add_argument("--save", metavar="NAME", help="save to evaluation/results/NAME.json")
    ap.add_argument("--compare", metavar="NAME", help="compare with evaluation/results/NAME.json")
    ap.add_argument("--no-video", action="store_true", help="skip all recorded videos (also --mcfd)")
    ap.add_argument("--mcfd", metavar="DIR", default=os.environ.get("ML_MCFD_DIR"),
                    help="Multiple Cameras Fall Dataset folder (default: ML_MCFD_DIR); see evaluation/datasets.py")
    ap.add_argument("--mcfd-cameras", default=MCFD_CAMERAS,
                    help=f"cameras 1-8, e.g. 1,3-5, or test (default {MCFD_CAMERAS})")
    ap.add_argument("--mcfd-scenarios", default="1-24",
                    help="scenarios 1-24 (default all; 'test' = the held-out test scenarios of evaluation/datasets.py)")
    ap.add_argument("--weights", help="pose weights instead of inference.weights")
    ap.add_argument("--classifier", choices=("rules", "learned"), help="instead of fall.classifier")
    args = ap.parse_args()

    cfg = config.load(args.config, prod_mode=False)
    if args.weights:
        cfg.inference = replace(cfg.inference, weights=str(Path(args.weights).resolve()))
    if args.classifier:
        cfg.detector = replace(cfg.detector, classifier=args.classifier)
    synthetic = run_synthetic(cfg)
    videos = {} if args.no_video else run_videos(cfg)
    mc = None
    if args.mcfd and not args.no_video:
        root = Path(args.mcfd)
        if not root.is_dir():
            ap.error(f"--mcfd: {root} is not a folder")
        scen = list(mcfd.TEST_SCENARIOS) if args.mcfd_scenarios == "test" else mcfd.parse_list(args.mcfd_scenarios, 1, 24)
        cams = list(mcfd.TEST_CAMERAS) if args.mcfd_cameras == "test" else mcfd.parse_list(args.mcfd_cameras, 1, 8)
        mc = run_mcfd(cfg, root, scen, cams)
    res = {
        "name": args.save or "unsaved",
        "date": time.strftime("%Y-%m-%d %H:%M"),
        "commit": git_commit(),
        "settings": settings(cfg),
        "summary": summarize(synthetic, videos, mc),
        "synthetic": synthetic,
        "videos": videos,
    } | ({"mcfd": mc} if mc else {})
    print_report(res)
    if args.compare:
        print_compare(json.loads((RESULTS / f"{args.compare}.json").read_text(encoding="utf-8")), res)
    if args.save:
        RESULTS.mkdir(exist_ok=True)
        (RESULTS / f"{args.save}.json").write_text(json.dumps(res, indent=2), encoding="utf-8")
        print(f"\nsaved evaluation/results/{args.save}.json")


if __name__ == "__main__":
    main()
