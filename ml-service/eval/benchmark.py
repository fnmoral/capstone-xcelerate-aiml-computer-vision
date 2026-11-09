"""Fall-detection benchmark: measures how many falls are caught and how many false alarms are raised.

    python -m eval.benchmark                         # run and print the results
    python -m eval.benchmark --save 01-my-change     # also keep them in eval/results/01-my-change.json
    python -m eval.benchmark --compare 00-baseline   # show what changed against a saved run
    python -m eval.benchmark --no-video              # synthetic scenarios only (no model needed)

Two parts:
- Synthetic scenarios (eval/scenarios.py): scripted keypoints for falls and for everyday things
  that look a bit like falls (bending, sitting, squatting...). Each runs with several random
  seeds. Fast, needs no model, and tests the fall logic on its own.
- Recorded videos (eval/videos.yaml): the real model and tracker on real footage. The model's
  output is cached in eval/.cache, so only a change to the model, tracker or vision/pose.py
  runs it again.

Both feed the same FallDetector the live service uses, with the settings from config.yaml.
"""

import argparse
import hashlib
import json
import pickle
import subprocess
import sys
import time
from dataclasses import asdict
from pathlib import Path

import numpy as np
import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import config  # noqa: E402
from eval.scenarios import FRAME_H, FRAME_W, render, scenarios  # noqa: E402
from fall.detector import FallDetector  # noqa: E402
from fall.rules import FALLING, LYING  # noqa: E402
from fall.state_machine import STARTED  # noqa: E402

EVAL = Path(__file__).resolve().parent
RESULTS = EVAL / "results"
CACHE = EVAL / ".cache"
SEEDS = 5
EARLY_TOLERANCE_S = 0.5   # an alert this much before the ground-truth start still counts
DOWN = (LYING, FALLING)


def replay(cfg: config.Config, frames, frame_shape) -> tuple[list[tuple[float, int]], list[tuple[float, str]]]:
    """Feed frames of (time, people) to a fresh detector.

    Returns the alerts as (alert time, incident start time) and every person-frame label as (time, label).
    """
    det = FallDetector(cfg.rules, cfg.monitor, cfg.detector)
    alerts, labels = [], []
    for t, people in frames:
        results, events = det.process(t, people, frame_shape)
        labels += [(t, r.label) for r in results]
        alerts += [(e.at, e.incident.started_at) for e in events if e.kind == STARTED]
        det.expire(t)
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

def _fingerprint(cfg: config.Config, video: Path) -> str:
    import ultralytics
    inf = cfg.inference
    tracker = Path(inf.tracker)
    parts = [
        video.name, str(video.stat().st_size), str(int(video.stat().st_mtime)),
        Path(inf.weights).name, str(inf.imgsz), str(inf.conf), str(inf.target_fps),
        json.dumps(asdict(inf), sort_keys=True, default=str),
        tracker.read_text() if tracker.is_file() else inf.tracker,
        (ROOT / "vision" / "pose.py").read_text(encoding="utf-8"),
        ultralytics.__version__,
    ]
    return hashlib.sha256("\n".join(parts).encode()).hexdigest()[:16]


def detect_video(cfg: config.Config, video: Path):
    """Run the pose tracker over a video at target_fps. Cached by everything that affects the output."""
    CACHE.mkdir(exist_ok=True)
    cached = CACHE / f"{video.stem}-{_fingerprint(cfg, video)}.pkl"
    if cached.exists():
        return pickle.loads(cached.read_bytes())

    import cv2
    from vision.pose import PoseTracker
    tracker = PoseTracker.from_config(cfg.inference)
    cap = cv2.VideoCapture(str(video))
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    step = 1.0 / cfg.inference.target_fps
    frames, shape, i, next_t = [], None, 0, 0.0
    started = time.perf_counter()
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        t = i / fps
        i += 1
        if t + 1e-6 < next_t:
            continue
        next_t += step
        shape = frame.shape
        frames.append((t, tracker(frame)))
    cap.release()
    print(f"  {video.name}: ran the model on {len(frames)} frames in {time.perf_counter() - started:.0f} s",
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


# --------------------------------------------------------------------------- summary & output

def _mean(xs):
    return round(float(np.mean(xs)), 2) if xs else None


def _pct(a, b):
    return round(100.0 * a / b, 1) if b else None


def summarize(synthetic: dict, videos: dict) -> dict:
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

    print(f"\n| Scenario | Fall? | Caught | False alarms | Time to alert | Wrong 'down' frames |")
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
                     ("video_false_alarms", "Video false alarms")]:
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
    ap.add_argument("--save", metavar="NAME", help="save to eval/results/NAME.json")
    ap.add_argument("--compare", metavar="NAME", help="compare with eval/results/NAME.json")
    ap.add_argument("--no-video", action="store_true", help="skip the recorded videos")
    args = ap.parse_args()

    cfg = config.load(args.config, prod_mode=False)
    synthetic = run_synthetic(cfg)
    videos = {} if args.no_video else run_videos(cfg)
    res = {
        "name": args.save or "unsaved",
        "date": time.strftime("%Y-%m-%d %H:%M"),
        "commit": git_commit(),
        "settings": settings(cfg),
        "summary": summarize(synthetic, videos),
        "synthetic": synthetic,
        "videos": videos,
    }
    print_report(res)
    if args.compare:
        print_compare(json.loads((RESULTS / f"{args.compare}.json").read_text(encoding="utf-8")), res)
    if args.save:
        RESULTS.mkdir(exist_ok=True)
        (RESULTS / f"{args.save}.json").write_text(json.dumps(res, indent=2), encoding="utf-8")
        print(f"\nsaved eval/results/{args.save}.json")


if __name__ == "__main__":
    main()
