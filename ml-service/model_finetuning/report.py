"""Fine-tuning report: training progress, hyperparameters and before/after results, in Excel + CSV + charts.

    python -m model_finetuning.report --mcfd "C:/datasets/Fall Dataset" \\
        --results 09-test-standard-rules 10-test-finetuned-rules 11-test-finetuned-learned

Writes model_finetuning/reports/:
    fine_tuning_report.xlsx   every table below as a sheet, plus the charts
    *.csv                     the same tables, one file each
    *.png                     the charts

It reads what training and testing left behind: the pose fine-tuning run (Ultralytics'
results.csv and args.yaml in <dataset>/work/runs/<run>), the training-label report, the Stage B
model card (models/stage_b.json) and saved benchmark runs (evaluation/results/<name>.json, the
first one is "before"). Anything missing is skipped, so it can be run at any stage.
Needs openpyxl for the .xlsx (pip install openpyxl); without it the CSVs and charts are still made.
"""

import argparse
import csv
import json
import os
import sys
from pathlib import Path

import yaml

ML = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ML))

OUT = ML / "model_finetuning" / "reports"
RESULTS = ML / "evaluation" / "results"
STAGE_B_CARD = ML / "models" / "stage_b.json"

# Chart style (validated categorical slots 1-3; text in ink colours, never series colours).
SURFACE, INK, INK_2, GRID = "#fcfcfb", "#0b0b0b", "#52514e", "#e6e5e1"
SERIES = ["#2a78d6", "#eb6834", "#1baf7a"]


# --------------------------------------------------------------------------- reading

def read_csv(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with path.open(encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    return [{k.strip(): _num(v) for k, v in r.items()} for r in rows]


def _num(v):
    try:
        f = float(v)
        return int(f) if f.is_integer() else round(f, 5)
    except (TypeError, ValueError):
        return v


def column(rows: list[dict], *needles: str) -> str | None:
    """The first column whose name contains all needles (Ultralytics' names vary by version)."""
    for k in (rows[0] if rows else {}):
        if all(n in k for n in needles):
            return k
    return None


def variant_name(res: dict) -> str:
    s = res.get("settings", {})
    weights = s.get("inference", {}).get("weights", "?").replace(".pt", "")
    model = "fine-tuned pose model" if "finetuned" in weights else "standard pose model"
    clf = "Stage B" if s.get("detector", {}).get("classifier") == "learned" else "rules"
    return f"{model} + {clf}"


# --------------------------------------------------------------------------- tables

def pose_epochs(run: Path) -> list[dict]:
    rows = read_csv(run / "results.csv")
    keep = []
    for r in rows:
        out = {"epoch": r.get("epoch")}
        for label, needles in [
            ("train box loss", ("train/box",)), ("train pose loss", ("train/pose",)),
            ("train keypoint-visibility loss", ("train/kobj",)), ("train class loss", ("train/cls",)),
            ("train body-point L1 loss", ("train/l1",)), ("train body-point RLE loss", ("train/rle",)),
            ("val box loss", ("val/box",)), ("val pose loss", ("val/pose",)),
            ("val keypoint-visibility loss", ("val/kobj",)), ("val class loss", ("val/cls",)),
            ("val body-point L1 loss", ("val/l1",)), ("val body-point RLE loss", ("val/rle",)),
            ("box precision", ("precision(B)",)), ("box recall", ("recall(B)",)),
            ("box mAP50", ("mAP50(B)",)), ("box mAP50-95", ("mAP50-95(B)",)),
            ("pose precision", ("precision(P)",)), ("pose recall", ("recall(P)",)),
            ("pose mAP50", ("mAP50(P)",)), ("pose mAP50-95", ("mAP50-95(P)",)),
            ("learning rate", ("lr/pg0",)), ("time (s)", ("time",)),
        ]:
            col = column(rows, *needles)
            if col and not (label == "box mAP50" and "95" in col) and not (label == "pose mAP50" and "95" in col):
                out[label] = r[col]
        keep.append(out)
    return keep


def hyperparameters(run: Path, root: Path) -> list[dict]:
    rows = []
    args = run / "args.yaml"
    if args.exists():
        a = yaml.safe_load(args.read_text(encoding="utf-8"))
        explain = {
            "model": "starting point (the standard model)", "epochs": "passes over the training images",
            "patience": "stop after this many epochs without improvement", "batch": "images per step",
            "imgsz": "image size the model sees", "optimizer": "how weights are updated (auto = chosen by Ultralytics)",
            "lr0": "starting learning rate", "lrf": "final learning rate, as a fraction of lr0",
            "cos_lr": "learning rate follows a cosine curve", "momentum": "optimizer momentum",
            "weight_decay": "penalty on large weights (less over-fitting)", "warmup_epochs": "slow start",
            "degrees": "random rotation, degrees", "fliplr": "chance of a mirrored image",
            "mosaic": "chance of combining 4 images into one", "close_mosaic": "last epochs without mosaic",
            "hsv_h": "random colour change", "hsv_s": "random saturation change", "hsv_v": "random brightness change",
            "translate": "random shift", "scale": "random zoom", "pose": "weight of the body-point loss",
            "kobj": "weight of the point-visibility loss", "box": "weight of the box loss",
            "cls": "weight of the class loss", "device": "where it trained", "seed": "random seed",
        }
        for k in ("model", "epochs", "patience", "batch", "imgsz", "optimizer", "lr0", "lrf", "cos_lr",
                  "momentum", "weight_decay", "warmup_epochs", "box", "pose", "kobj", "cls", "degrees",
                  "fliplr", "mosaic", "close_mosaic", "hsv_h", "hsv_s", "hsv_v", "translate", "scale",
                  "device", "seed"):
            if k in a:
                v = Path(a[k]).name if k == "model" else a[k]
                rows.append({"part": "pose fine-tuning", "setting": k, "value": v, "meaning": explain.get(k, "")})
    from model_finetuning.finetune import EVERY_DOWN_S, EVERY_S, MIN_CONF, TEACHER
    from evaluation import datasets as mcfd
    rows += [
        {"part": "training labels", "setting": "teacher model", "value": TEACHER,
         "meaning": "the large model that labelled the training frames"},
        {"part": "training labels", "setting": "teacher confidence", "value": MIN_CONF,
         "meaning": "frames where the teacher was less sure were left out"},
        {"part": "training labels", "setting": "rotation", "value": "90 and 270 degrees",
         "meaning": "tried when nobody was found upright (finds people lying down)"},
        {"part": "training labels", "setting": "frames per second sampled", "value": f"{1 / EVERY_S:g} (falling/lying: {1 / EVERY_DOWN_S:g})",
         "meaning": "more frames where they matter most"},
        {"part": "data split", "setting": "training scenarios", "value": ", ".join(map(str, [s for s in mcfd.TRAIN_SCENARIOS if s not in mcfd.VAL_SCENARIOS])), "meaning": ""},
        {"part": "data split", "setting": "validation scenarios", "value": ", ".join(map(str, mcfd.VAL_SCENARIOS)),
         "meaning": "used during training to pick the best epoch"},
        {"part": "data split", "setting": "test scenarios", "value": ", ".join(map(str, mcfd.TEST_SCENARIOS)),
         "meaning": "never seen in training; all before/after numbers"},
        {"part": "data split", "setting": "training cameras", "value": ", ".join(map(str, mcfd.TRAIN_CAMERAS)), "meaning": ""},
        {"part": "data split", "setting": "test cameras", "value": ", ".join(map(str, mcfd.TEST_CAMERAS)),
         "meaning": "camera positions never seen in training"},
    ]
    card = json.loads(STAGE_B_CARD.read_text(encoding="utf-8")) if STAGE_B_CARD.exists() else None
    if card:
        for k, v in card["hyperparameters"].items():
            rows.append({"part": "Stage B classifier", "setting": k, "value": str(v), "meaning": ""})
        rows.append({"part": "Stage B classifier", "setting": "decision threshold", "value": card["threshold"],
                     "meaning": "picked on validation for balanced accuracy"})
        rows.append({"part": "Stage B classifier", "setting": "trained on pose model", "value": card["pose_weights"], "meaning": ""})
    return rows


def label_report(root: Path) -> list[dict]:
    p = root / "work" / "pose_dataset" / "label_report.json"
    if not p.exists():
        return []
    rep = json.loads(p.read_text(encoding="utf-8"))
    return [{"activity": k, "frames tried": v["frames"], "labelled %": v["labelled_pct"],
             "found only after rotating": v["via_rotation"]} for k, v in rep.items()]


def stage_b_rows() -> tuple[list[dict], list[dict]]:
    if not STAGE_B_CARD.exists():
        return [], []
    card = json.loads(STAGE_B_CARD.read_text(encoding="utf-8"))
    hist = [{"epoch": h["epoch"], "training loss": h["train_loss"], "validation loss": h["val_loss"]} for h in card["history"]]
    acts = [{"activity": k, "validation windows": v["windows"], "labelled down %": v["labelled_down_pct"]}
            for k, v in card["validation_by_activity"].items()]
    return hist, acts


def before_after(results: list[dict]) -> tuple[list[dict], list[dict], list[dict]]:
    names = [variant_name(r) for r in results]
    metrics = [
        ("Falls caught, cameras as one zone (%)", lambda m: _pct(m["zone"]["caught"], m["zone"]["expected"])),
        ("Falls caught, cameras as one zone", lambda m: f"{m['zone']['caught']}/{m['zone']['expected']}"),
        ("False alarms, cameras as one zone", lambda m: m["zone"]["false_alarm_count"]),
        ("Extra alerts for the same fall (zone)", lambda m: m["zone"]["duplicates"]),
        ("Short falls caught (zone)", lambda m: f"{m['zone']['short_caught']}/{m['zone']['short']}"),
        ("Falls caught, each camera on its own (%)", lambda m: _pct(m["camera"]["caught"], m["camera"]["expected"])),
        ("False alarms, each camera on its own", lambda m: m["camera"]["false_alarm_count"]),
        ("Mean time to alert (s)", lambda m: m["camera"]["time_to_alert_s"]),
        ("Lying on the ground: frames labelled down (%)", lambda m: m["labels"].get("lying on the ground", {}).get("down_pct")),
        ("Falling: frames labelled down (%)", lambda m: m["labels"].get("falling", {}).get("down_pct")),
        ("Lying on a sofa: frames labelled down (%)", lambda m: m["labels"].get("lying on a sofa", {}).get("down_pct")),
        ("Sitting: frames labelled down (%)", lambda m: m["labels"].get("sitting", {}).get("down_pct")),
        ("Walking/standing: frames labelled down (%)", lambda m: m["labels"].get("walking/standing", {}).get("down_pct")),
        ("Lying on the ground: person found (person-frames)", lambda m: m["labels"].get("lying on the ground", {}).get("frames")),
    ]
    summary = []
    for label, f in metrics:
        row = {"metric": label}
        for n, r in zip(names, results):
            row[n] = f(r["mcfd"]) if r.get("mcfd") else None
        summary.append(row)
    for label, key in [("Synthetic falls caught", "synthetic_falls_caught"), ("Synthetic false alarms", "synthetic_false_alarms"),
                       ("Test videos: falls caught", "video_falls_caught"), ("Test videos: false alarms", "video_false_alarms")]:
        summary.append({"metric": label} | {n: r["summary"].get(key) for n, r in zip(names, results)})
    per_scenario, labels = [], []
    for n, r in zip(names, results):
        mc = r.get("mcfd") or {}
        for s, row in mc.get("per_scenario", {}).items():
            for where, v in row.items():
                per_scenario.append({"variant": n, "scenario": int(s), "camera": where, "falls expected": v["expected"],
                                     "caught": v["caught"], "short falls": v["short"], "short caught": v["short_caught"],
                                     "false alarms": v["false_alarms"]})
        for act, v in mc.get("labels", {}).items():
            labels.append({"variant": n, "activity": act, "person-frames": v["frames"], "labelled down %": v["down_pct"],
                           "labelled unclear %": v["unclear_pct"]})
    return summary, per_scenario, labels


def _pct(a, b):
    return round(100 * a / b, 1) if b else None


# --------------------------------------------------------------------------- charts

def _style(ax, title: str, ylabel: str):
    ax.set_facecolor(SURFACE)
    ax.set_title(title, loc="left", fontsize=11, color=INK, pad=10)
    ax.set_ylabel(ylabel, fontsize=9, color=INK_2)
    ax.tick_params(colors=INK_2, labelsize=8, length=0)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_color(GRID)
    ax.grid(axis="y", color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)


def _line(ax, x, y, i, label):
    ax.plot(x, y, color=SERIES[i], linewidth=2, marker="o", markersize=4.5,
            markeredgecolor=SURFACE, markeredgewidth=1.5, label=label)


def chart_pose(rows: list[dict], path: Path) -> Path | None:
    if not rows:
        return None
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    ep = [r["epoch"] for r in rows]
    panels = [("Body-point (pose) loss", "loss", [("train pose loss", "training"), ("val pose loss", "validation")]),
              ("Box loss", "loss", [("train box loss", "training"), ("val box loss", "validation")]),
              ("Validation accuracy (mAP50)", "mAP50, 0-1", [("pose mAP50", "body points"), ("box mAP50", "boxes")]),
              ("Learning rate", "learning rate", [("learning rate", "learning rate")])]
    fig, axes = plt.subplots(2, 2, figsize=(11, 7), facecolor=SURFACE)
    for ax, (title, ylabel, series) in zip(axes.flat, panels):
        _style(ax, title, ylabel)
        for i, (col, label) in enumerate(series):
            if col in rows[0]:
                _line(ax, ep, [r[col] for r in rows], i, label)
        ax.set_xlabel("epoch", fontsize=9, color=INK_2)
        from matplotlib.ticker import MaxNLocator
        ax.xaxis.set_major_locator(MaxNLocator(integer=True))
        if len(series) > 1:
            ax.legend(frameon=False, fontsize=8, labelcolor=INK_2, loc="best")
    fig.suptitle("Pose model fine-tuning, per epoch", x=0.01, ha="left", fontsize=13, color=INK)
    fig.tight_layout()
    fig.savefig(path, dpi=150, facecolor=SURFACE)
    plt.close(fig)
    return path


def chart_stage_b(hist: list[dict], path: Path) -> Path | None:
    if not hist:
        return None
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, ax = plt.subplots(figsize=(8, 4), facecolor=SURFACE)
    _style(ax, "Stage B classifier training, per epoch", "loss")
    ep = [h["epoch"] for h in hist]
    _line(ax, ep, [h["training loss"] for h in hist], 0, "training")
    _line(ax, ep, [h["validation loss"] for h in hist], 1, "validation")
    best = min(hist, key=lambda h: h["validation loss"])
    ax.annotate(f"best: epoch {best['epoch']}", (best["epoch"], best["validation loss"]), textcoords="offset points",
                xytext=(0, -16), ha="center", fontsize=8, color=INK_2)
    ax.set_xlabel("epoch", fontsize=9, color=INK_2)
    from matplotlib.ticker import MaxNLocator
    ax.xaxis.set_major_locator(MaxNLocator(integer=True))
    ax.legend(frameon=False, fontsize=8, labelcolor=INK_2)
    fig.tight_layout()
    fig.savefig(path, dpi=150, facecolor=SURFACE)
    plt.close(fig)
    return path


def chart_before_after(results: list[dict], path: Path) -> Path | None:
    results = [r for r in results if r.get("mcfd")][:3]
    if not results:
        return None
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    names = [variant_name(r) for r in results]
    panels = [
        ("Falls caught (zone, %)", "%", [_pct(r["mcfd"]["zone"]["caught"], r["mcfd"]["zone"]["expected"]) or 0 for r in results]),
        ("False alarms (zone)", "count", [r["mcfd"]["zone"]["false_alarm_count"] for r in results]),
        ("Lying-on-floor frames\nlabelled down (%)", "%",
         [r["mcfd"]["labels"].get("lying on the ground", {}).get("down_pct") or 0 for r in results]),
    ]
    fig, axes = plt.subplots(1, 3, figsize=(12, 4.2), facecolor=SURFACE)
    for ax, (title, ylabel, values) in zip(axes, panels):
        _style(ax, title, ylabel)
        x = range(len(values))
        bars = ax.bar(x, values, width=0.6, color=SERIES[:len(values)], edgecolor=SURFACE, linewidth=2)
        for b, v in zip(bars, values):  # values on the bars (also the contrast relief for the light hue)
            ax.annotate(f"{v:g}", (b.get_x() + b.get_width() / 2, b.get_height()), textcoords="offset points",
                        xytext=(0, 3), ha="center", fontsize=9, color=INK)
        ax.set_xticks([])
        ax.set_xlim(-0.6, 2.6)          # room for 3 bars, so bar width doesn't depend on how many
        ax.margins(y=0.15)
        if ylabel == "count":
            from matplotlib.ticker import MaxNLocator
            ax.yaxis.set_major_locator(MaxNLocator(integer=True))
    handles = [plt.Rectangle((0, 0), 1, 1, color=SERIES[i]) for i in range(len(names))]
    fig.legend(handles, names, loc="lower center", ncol=len(names), frameon=False, fontsize=9, labelcolor=INK_2)
    fig.suptitle("Before and after, on the held-out test scenarios and cameras", x=0.01, ha="left", fontsize=13, color=INK)
    fig.tight_layout(rect=(0, 0.08, 1, 1))
    fig.savefig(path, dpi=150, facecolor=SURFACE)
    plt.close(fig)
    return path


# --------------------------------------------------------------------------- output

def write_csv(path: Path, rows: list[dict]) -> None:
    if not rows:
        return
    keys = list(dict.fromkeys(k for r in rows for k in r))
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=keys)
        w.writeheader()
        w.writerows(rows)


def write_xlsx(path: Path, sheets: dict[str, list[dict]], charts: list[Path], notes: list[str]) -> bool:
    try:
        from openpyxl import Workbook
        from openpyxl.drawing.image import Image
        from openpyxl.styles import Alignment, Font, PatternFill
    except ImportError:
        print("openpyxl not installed: wrote the CSVs and charts only (pip install openpyxl)")
        return False
    wb = Workbook()
    ws = wb.active
    ws.title = "Read me"
    for i, line in enumerate(notes, 1):
        ws.cell(row=i, column=1, value=line).font = Font(bold=(i == 1), size=13 if i == 1 else 11)
    ws.column_dimensions["A"].width = 120
    head_fill = PatternFill("solid", fgColor="E8E7E3")
    for name, rows in sheets.items():
        if not rows:
            continue
        s = wb.create_sheet(name[:31])
        keys = list(dict.fromkeys(k for r in rows for k in r))
        for j, k in enumerate(keys, 1):
            c = s.cell(row=1, column=j, value=k)
            c.font, c.fill = Font(bold=True), head_fill
            c.alignment = Alignment(wrap_text=True, vertical="top")
            s.column_dimensions[c.column_letter].width = max(12, min(48, len(str(k)) + 4))
        for i, r in enumerate(rows, 2):
            for j, k in enumerate(keys, 1):
                s.cell(row=i, column=j, value=r.get(k))
        s.freeze_panes = "B2"
    if charts:
        cs = wb.create_sheet("Charts")
        row = 1
        for p in charts:
            img = Image(str(p))
            img.width, img.height = img.width * 0.55, img.height * 0.55
            cs.add_image(img, f"A{row}")
            row += int(img.height / 20) + 3
    wb.save(path)
    return True


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mcfd", default=os.environ.get("ML_MCFD_DIR"), required=not os.environ.get("ML_MCFD_DIR"))
    ap.add_argument("--run", default="mcfd", help="pose fine-tuning run name in <dataset>/work/runs")
    ap.add_argument("--results", nargs="*", default=[], help="saved benchmark runs to compare; the first is 'before'")
    args = ap.parse_args()
    root = Path(args.mcfd)
    run = root / "work" / "runs" / args.run
    OUT.mkdir(parents=True, exist_ok=True)

    results = [json.loads((RESULTS / f"{n}.json").read_text(encoding="utf-8")) for n in args.results]
    epochs = pose_epochs(run)
    hist, acts = stage_b_rows()
    summary, per_scenario, labels = before_after(results) if results else ([], [], [])
    sheets = {
        "Before vs after": summary,
        "Per scenario": per_scenario,
        "Labels by activity": labels,
        "Pose fine-tuning per epoch": epochs,
        "Hyperparameters": hyperparameters(run, root),
        "Training labels": label_report(root),
        "Stage B per epoch": hist,
        "Stage B validation": acts,
    }
    for name, rows in sheets.items():
        write_csv(OUT / (name.lower().replace(" ", "_").replace("/", "_") + ".csv"), rows)
    charts = [p for p in (chart_before_after(results, OUT / "before_after.png"),
                          chart_pose(epochs, OUT / "pose_finetuning_progress.png"),
                          chart_stage_b(hist, OUT / "stage_b_training.png")) if p]
    notes = [
        "Fall detection: fine-tuning report",
        "",
        "Before vs after: the held-out test scenarios and cameras of the Multiple Cameras Fall Dataset (never used for training).",
        "Variants, in order: " + "; ".join(f"{n} ({variant_name(r)})" for n, r in zip(args.results, results)),
        "A fall counts when the person stays down at least confirm_seconds + 0.5 s; shorter ones are 'short falls'.",
        "Per scenario: 'zone' = the test cameras together, as one alert per fall would be raised.",
        "Pose fine-tuning per epoch: Ultralytics' training log. mAP50 = how well boxes / body points match the labels (0-1).",
        "Hyperparameters: every setting used, with what it means.",
        "Training labels: how many training frames the teacher model could label, per activity.",
        "Stage B: the learned classifier's training curve and its validation results per activity.",
        "Charts: the same numbers as pictures. Details in DETECTION_CHANGELOG.md.",
    ]
    ok = write_xlsx(OUT / "fine_tuning_report.xlsx", sheets, charts, notes)
    print(f"wrote {OUT.relative_to(ML)}: " + ", ".join(
        sorted(p.name for p in OUT.iterdir())) + ("" if ok else " (no .xlsx)"))


if __name__ == "__main__":
    main()
