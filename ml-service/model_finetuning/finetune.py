"""Training the model on the Multiple Cameras Fall Dataset. Three steps, one command each:

    python -m model_finetuning.finetune pose-labels --mcfd "C:/datasets/Fall Dataset"   # 1. label frames (hours on CPU)
    python -m model_finetuning.finetune finetune    --mcfd "..." --epochs 20            # 2. fine-tune the pose model
    python -m model_finetuning.finetune stage-b     --mcfd "..." --weights models/yolo26n-pose-finetuned-mcfDataset-<mmddyy>.pt  # 3. Stage B

Then test with python -m evaluation.evaluate (see evaluate.py). Only the training scenarios and
cameras of datasets.py are used, so the test scenarios and cameras stay unseen.
"""

import argparse
import collections
import dataclasses
import json
from datetime import date
import os
import shutil
import sys
import time
from collections import deque
from pathlib import Path

import cv2
import numpy as np

from app import config
from app.detection.fall_detection import WINDOW, frame_vector, window_vector
from evaluation import datasets as mcfd
from evaluation.evaluate import detect_video


# ================================================================================================
# 1. Pose labels: a big teacher model labels the training frames
# ================================================================================================

POSE_LABELS_DOC = """Build a YOLO-pose training set from the Multiple Cameras Fall Dataset, without hand labelling.

The dataset has activity labels but no body points. A large "teacher" model (yolo26x-pose)
labels the frames instead. It often misses a person lying on the floor, so when it finds
nobody confidently, the frame is rotated 90 and 270 degrees: lying down then looks like
standing up, which it recognises well, and the points are rotated back. Frames where even
that finds nobody are left out (better no label than a wrong "nobody here").

Only TRAIN_SCENARIOS x TRAIN_CAMERAS are used (evaluation/datasets.py); VAL_SCENARIOS become the
validation split. Test scenarios and cameras are never touched, so the benchmark stays fair.

    python -m model_finetuning.finetune pose-labels --mcfd "C:/datasets/Fall Dataset"
    -> <dataset>/work/pose_dataset/{images,labels}/{train,val}, dataset.yaml

Resumable: frames already labelled are skipped. Takes hours on a CPU (the teacher is large).
"""

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


TEACHER = "yolo26x-pose.pt"
MIN_CONF = 0.5            # teacher must be at least this sure
EVERY_S = 1.0             # one frame per second normally...
EVERY_DOWN_S = 0.25       # ...four per second while falling or lying: the frames we need most
FLIP_IDX = [0, 2, 1, 4, 3, 6, 5, 8, 7, 10, 9, 12, 11, 14, 13, 16, 15]
ROTATIONS = {90: cv2.ROTATE_90_CLOCKWISE, 270: cv2.ROTATE_90_COUNTERCLOCKWISE}


def unrotate(points: np.ndarray, angle: int, w: int, h: int) -> np.ndarray:
    """Map (x, y) points from a rotated frame back to the original frame of width w, height h."""
    x, y = points[..., 0], points[..., 1]
    if angle == 90:    # clockwise: original (x, y) -> (h - 1 - y, x)
        return np.stack([y, h - 1 - x], axis=-1)
    if angle == 270:   # counter-clockwise: original (x, y) -> (y, w - 1 - x)
        return np.stack([w - 1 - y, x], axis=-1)
    return points


def best_person(model, img: np.ndarray) -> tuple[float, np.ndarray, np.ndarray, int] | None:
    """The teacher's most confident person: (conf, box xyxy, keypoints (17, 3), rotation used)."""
    h, w = img.shape[:2]
    best = None
    for angle in (0, 90, 270):
        if angle and best is not None and best[0] >= MIN_CONF:
            break  # found upright already: no need to rotate
        im = img if angle == 0 else cv2.rotate(img, ROTATIONS[angle])
        r = model.predict(im, conf=0.25, imgsz=640, classes=[0], verbose=False)[0]
        if not len(r.boxes):
            continue
        i = int(r.boxes.conf.argmax())
        conf = float(r.boxes.conf[i])
        if best is not None and conf <= best[0]:
            continue
        kpts = r.keypoints.data[i].cpu().numpy().copy()
        x1, y1, x2, y2 = r.boxes.xyxy[i].cpu().numpy()
        corners = unrotate(np.array([[x1, y1], [x2, y1], [x1, y2], [x2, y2]]), angle, w, h)
        kpts[:, :2] = unrotate(kpts[:, :2], angle, w, h)
        box = np.array([*corners.min(0), *corners.max(0)])
        best = (conf, box, kpts, angle)
    return best if best is not None and best[0] >= MIN_CONF else None


def label_line(box: np.ndarray, kpts: np.ndarray, w: int, h: int) -> str:
    x1, y1, x2, y2 = np.clip(box, 0, [w - 1, h - 1, w - 1, h - 1])
    parts = [0, (x1 + x2) / 2 / w, (y1 + y2) / 2 / h, (x2 - x1) / w, (y2 - y1) / h]
    for x, y, c in kpts:
        v = 2 if c >= 0.5 else 1 if c >= 0.25 else 0
        parts += [x / w, y / h, v] if v else [0, 0, 0]
    return " ".join(f"{p:.6f}" if isinstance(p, float) else str(p) for p in parts)


def frames_to_label(scenario: int) -> list[tuple[int, int]]:
    """(frame on the common timeline, activity code) to label for one scenario."""
    out = []
    for a, b, code in mcfd.PERIODS[scenario]:
        step = (EVERY_DOWN_S if code in (mcfd.FALLING, mcfd.LYING_GROUND) else EVERY_S) * mcfd.MCFD_FPS
        out += [(int(f), code) for f in np.arange(a, b + 1, step)]
    return out


def pose_labels_main() -> None:
    ap = argparse.ArgumentParser(description=POSE_LABELS_DOC, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mcfd", default=os.environ.get("ML_MCFD_DIR"), required=not os.environ.get("ML_MCFD_DIR"))
    ap.add_argument("--teacher", default=TEACHER)
    args = ap.parse_args()
    root = Path(args.mcfd)
    out = root / "work" / "pose_dataset"
    os.chdir(root / "work" if (root / "work").exists() else root)  # teacher weights download outside the repo

    from ultralytics import YOLO
    teacher = YOLO(args.teacher)
    stats = collections.defaultdict(lambda: [0, 0, 0])   # activity -> [frames, labelled, via rotation]
    started = time.perf_counter()
    for s in mcfd.TRAIN_SCENARIOS:
        split = "val" if s in mcfd.VAL_SCENARIOS else "train"
        (out / "images" / split).mkdir(parents=True, exist_ok=True)
        (out / "labels" / split).mkdir(parents=True, exist_ok=True)
        todo = frames_to_label(s)
        for c in mcfd.TRAIN_CAMERAS:
            cap = cv2.VideoCapture(str(mcfd.video_path(root, s, c)))
            delay = mcfd.DELAYS[s][c - 1]
            for frame, code in todo:
                name = f"s{s:02d}c{c}_{frame:05d}"
                img_path, lbl_path = out / "images" / split / f"{name}.jpg", out / "labels" / split / f"{name}.txt"
                what = mcfd.ACTIVITY[code]
                if lbl_path.exists() or (out / "labels" / split / f"{name}.none").exists():
                    continue
                cap.set(cv2.CAP_PROP_POS_FRAMES, frame + delay)
                ok, img = cap.read()
                if not ok:
                    continue
                stats[what][0] += 1
                found = best_person(teacher, img)
                if found is None:
                    (out / "labels" / split / f"{name}.none").touch()  # remember: tried, nobody
                    continue
                conf, box, kpts, angle = found
                cv2.imwrite(str(img_path), img, [cv2.IMWRITE_JPEG_QUALITY, 92])
                lbl_path.write_text(label_line(box, kpts, img.shape[1], img.shape[0]) + "\n")
                stats[what][1] += 1
                stats[what][2] += angle != 0
            cap.release()
            done = sum(v[0] for v in stats.values())
            print(f"scenario {s:2d} cam {c}: {done} frames so far, {time.perf_counter() - started:.0f} s", flush=True)

    (out / "dataset.yaml").write_text(
        f"path: {out.as_posix()}\ntrain: images/train\nval: images/val\n"
        f"kpt_shape: [17, 3]\nflip_idx: {FLIP_IDX}\nnames:\n  0: person\n", encoding="utf-8")
    report = {k: {"frames": n, "labelled_pct": round(100 * l / n, 1) if n else None,
                  "via_rotation": r} for k, (n, l, r) in sorted(stats.items())}
    (out / "label_report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


# ================================================================================================
# 2. Fine-tune the pose model on those labels
# ================================================================================================

FINETUNE_DOC = """Fine-tune the pose model on the training set made by model_finetuning/finetune.py.

    python -m model_finetuning.finetune finetune --mcfd "C:/datasets/Fall Dataset" --epochs 20
    -> models/yolo26n-pose-finetuned-mcfDataset-<mmddyy>.pt (then set inference.weights in config.yaml)

Starts from the shipped yolo26n-pose.pt, so it keeps what it knows and learns people lying on
the floor seen from ceiling cameras. On a CPU this takes hours; on a CUDA GPU minutes
(--device 0). Training runs are kept in <dataset>/work/runs (outside the repo and OneDrive).
"""

sys.path.insert(0, str(ROOT))

# Dated, so each fine-tuning run is kept as its own model (e.g. ...-mcfDataset-111026.pt for 10 Nov 2026).
POSE_OUTPUT = ROOT / "models" / f"yolo26n-pose-finetuned-mcfDataset-{date.today():%m%d%y}.pt"


def finetune_main() -> None:
    ap = argparse.ArgumentParser(description=FINETUNE_DOC, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mcfd", default=os.environ.get("ML_MCFD_DIR"), required=not os.environ.get("ML_MCFD_DIR"))
    ap.add_argument("--base", default=str(ROOT / "models" / "yolo26n-pose.pt"))
    ap.add_argument("--epochs", type=int, default=20)
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--name", default="mcfd")
    ap.add_argument("--resume", action="store_true",
                    help="continue a stopped run from its last epoch (same --name), instead of starting over")
    args = ap.parse_args()

    work = Path(args.mcfd) / "work"
    data = work / "pose_dataset" / "dataset.yaml"
    if not data.exists():
        sys.exit(f"{data} not found: run python -m model_finetuning.finetune pose-labels first")

    from ultralytics import YOLO
    if args.resume:
        last = work / "runs" / args.name / "weights" / "last.pt"
        if not last.exists():
            sys.exit(f"{last} not found: nothing to resume")
        YOLO(str(last)).train(resume=True)  # keeps the run's own settings and epoch count
    else:
        YOLO(args.base).train(
            data=str(data), epochs=args.epochs, imgsz=args.imgsz, batch=args.batch, device=args.device,
            project=str(work / "runs"), name=args.name, exist_ok=True,
            workers=2, patience=6, plots=False, cos_lr=True,
            # A fallen person can lie at any angle in the picture: let training see some rotation.
            degrees=15.0, fliplr=0.5, mosaic=1.0, close_mosaic=3,
        )
    best = work / "runs" / args.name / "weights" / "best.pt"
    POSE_OUTPUT.parent.mkdir(exist_ok=True)
    shutil.copy2(best, POSE_OUTPUT)
    print(f"saved {POSE_OUTPUT}")


# ================================================================================================
# 3. Stage B: train the learned fall classifier
# ================================================================================================

STAGE_B_DOC = """Train the Stage B classifier (app/detection/fall_detection.py) on the Multiple Cameras Fall Dataset.

    python -m model_finetuning.finetune stage-b --mcfd "C:/datasets/Fall Dataset" --weights models/yolo26n-pose-finetuned-mcfDataset-<mmddyy>.pt
    -> models/stage_b.npz  (then set fall.classifier: learned in config.yaml)

Examples come from the pose model's own output (the same detections the live service would
see, cached like the benchmark's), labelled with the dataset's activity codes: "down" while
falling or lying on the ground, "not down" for everything else, including lying on a sofa.
Only TRAIN_SCENARIOS x TRAIN_CAMERAS are used; VAL_SCENARIOS pick the epoch and the decision
threshold. Train with the same pose weights you will run it with.
"""

sys.path.insert(0, str(ROOT))


STAGE_B_OUTPUT = ROOT / "models" / "stage_b.npz"
VERSION = "0.1.0"
HIDDEN = (64, 32)        # hidden layer sizes of the small network
LEARNING_RATE = 1e-3
WEIGHT_DECAY = 1e-4
DROPOUT = 0.2
BATCH_SIZE = 256


def flip(frame: np.ndarray) -> np.ndarray:
    """The same frame mirrored left-right (doubles the examples, other viewing sides)."""
    pts = frame[:51].reshape(17, 3)[FLIP_IDX].copy()
    pts[:, 0] = -pts[:, 0]
    box = frame[51:].copy()
    box[4] = 1.0 - box[4]  # box centre x
    return np.concatenate([pts.ravel(), box])


def examples(cfg: config.Config, root: Path, scenarios, cameras):
    """Windows of frames for the most confident person in each frame, and whether they are down."""
    windows, labels, codes = [], [], []
    for s in scenarios:
        a, b = mcfd.annotated(s)
        for c in cameras:
            frames, shape = detect_video(cfg, mcfd.video_path(root, s, c), fps=mcfd.MCFD_FPS,
                                         offset_frames=mcfd.DELAYS[s][c - 1], start_s=max(a - 1.0, 0.0), end_s=b)
            history: dict[int, deque] = {}
            for t, people in frames:
                for p in people:
                    history.setdefault(p.track_id, deque(maxlen=WINDOW)).append(
                        frame_vector(p.box, p.keypoints, shape, cfg.detector.min_keypoint_conf))
                code = mcfd.activity_at(s, t)
                if not people or code is None:
                    continue
                actor = max(people, key=lambda p: p.confidence)  # one actor per scenario
                windows.append(list(history[actor.track_id]))
                labels.append(code in (mcfd.FALLING, mcfd.LYING_GROUND))
                codes.append(code)
    return windows, np.array(labels, dtype=np.float32), np.array(codes)


def to_matrix(windows, mirrored: bool = False) -> np.ndarray:
    return np.stack([window_vector([flip(f) for f in w] if mirrored else w) for w in windows])


def train(x_tr, y_tr, x_va, y_va, epochs: int, seed: int = 0):
    import torch
    torch.manual_seed(seed)
    layers, dims = [], [x_tr.shape[1], *HIDDEN, 1]
    for i in range(len(dims) - 1):
        layers.append(torch.nn.Linear(dims[i], dims[i + 1]))
        if i < len(dims) - 2:
            layers += [torch.nn.ReLU(), torch.nn.Dropout(DROPOUT)]
    net = torch.nn.Sequential(*layers)
    pos = max(float(y_tr.sum()), 1.0)
    loss_fn = torch.nn.BCEWithLogitsLoss(pos_weight=torch.tensor((len(y_tr) - pos) / pos))
    opt = torch.optim.Adam(net.parameters(), lr=LEARNING_RATE, weight_decay=WEIGHT_DECAY)
    xt, yt = torch.tensor(x_tr), torch.tensor(y_tr)
    xv, yv = torch.tensor(x_va), torch.tensor(y_va)
    best, best_state, history = float("inf"), None, []
    for epoch in range(epochs):
        net.train()
        losses = []
        for idx in torch.randperm(len(xt)).split(BATCH_SIZE):
            opt.zero_grad()
            loss = loss_fn(net(xt[idx]).squeeze(1), yt[idx])
            loss.backward()
            opt.step()
            losses.append(float(loss))
        net.eval()
        with torch.no_grad():
            val = float(loss_fn(net(xv).squeeze(1), yv))
        if val < best:
            best, best_state = val, {k: v.clone() for k, v in net.state_dict().items()}
        history.append({"epoch": epoch + 1, "train_loss": round(float(np.mean(losses)), 5),
                        "val_loss": round(val, 5), "best_so_far": val <= best})
        print(f"epoch {epoch + 1:2d}  training loss {np.mean(losses):.4f}  validation loss {val:.4f}", flush=True)
    net.load_state_dict(best_state)
    net.eval()
    with torch.no_grad():
        p_va = torch.sigmoid(net(xv).squeeze(1)).numpy()
    linears = [m for m in net if isinstance(m, torch.nn.Linear)]
    return [(m.weight.detach().numpy().T.copy(), m.bias.detach().numpy().copy()) for m in linears], p_va, history


def pick_threshold(p: np.ndarray, y: np.ndarray) -> float:
    """Best balanced accuracy on validation (equal weight to catching falls and to staying quiet)."""
    best_t, best_score = 0.5, -1.0
    for t in np.arange(0.3, 0.86, 0.05):
        pred = p >= t
        tpr = (pred & (y == 1)).sum() / max((y == 1).sum(), 1)
        tnr = (~pred & (y == 0)).sum() / max((y == 0).sum(), 1)
        if (tpr + tnr) / 2 > best_score:
            best_t, best_score = float(t), (tpr + tnr) / 2
    return round(best_t, 2)


def stage_b_main() -> None:
    ap = argparse.ArgumentParser(description=STAGE_B_DOC, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mcfd", default=os.environ.get("ML_MCFD_DIR"), required=not os.environ.get("ML_MCFD_DIR"))
    ap.add_argument("--config", default=str(ROOT / "config.yaml"))
    ap.add_argument("--weights", help="pose weights to train with (default: inference.weights)")
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--output", default=str(STAGE_B_OUTPUT))
    args = ap.parse_args()

    cfg = config.load(args.config, prod_mode=False)
    if args.weights:
        cfg = dataclasses.replace(cfg, inference=dataclasses.replace(cfg.inference, weights=str(Path(args.weights).resolve())))
    root = Path(args.mcfd)
    train_s = [s for s in mcfd.TRAIN_SCENARIOS if s not in mcfd.VAL_SCENARIOS]
    print("collecting examples (runs the pose model on videos not cached yet)...", flush=True)
    w_tr, y_tr, _ = examples(cfg, root, train_s, mcfd.TRAIN_CAMERAS)
    w_va, y_va, c_va = examples(cfg, root, mcfd.VAL_SCENARIOS, mcfd.TRAIN_CAMERAS)
    x_tr = np.concatenate([to_matrix(w_tr), to_matrix(w_tr, mirrored=True)])
    y_tr2 = np.concatenate([y_tr, y_tr])
    x_va = to_matrix(w_va)
    mean, std = x_tr.mean(0), np.maximum(x_tr.std(0), 1e-3)
    print(f"{len(y_tr)} training windows ({int(y_tr.sum())} down), {len(y_va)} validation ({int(y_va.sum())} down)")

    layers, p_va, history = train(((x_tr - mean) / std).astype(np.float32), y_tr2, ((x_va - mean) / std).astype(np.float32),
                         y_va, args.epochs)
    threshold = pick_threshold(p_va, y_va)
    pred = p_va >= threshold
    print(f"threshold {threshold}: validation labelled down by activity:")
    by_activity = {}
    for code in sorted(set(c_va.tolist())):
        m = c_va == code
        by_activity[mcfd.ACTIVITY[code]] = {"windows": int(m.sum()), "labelled_down_pct": round(100 * float(pred[m].mean()), 1)}
        print(f"  {mcfd.ACTIVITY[code]:20s} {100 * pred[m].mean():5.1f}%  ({m.sum()} windows)")

    out = Path(args.output)
    out.parent.mkdir(exist_ok=True)
    arrays = {f"w{i}": w for i, (w, _) in enumerate(layers)} | {f"b{i}": b for i, (_, b) in enumerate(layers)}
    np.savez(out, n_layers=len(layers), mean=mean.astype(np.float32), std=std.astype(np.float32),
             threshold=threshold, version=f"{VERSION}+{Path(cfg.inference.weights).stem}", **arrays)
    # A readable "model card" next to the model: settings, data and results (used by the report).
    card = {
        "version": f"{VERSION}+{Path(cfg.inference.weights).stem}",
        "pose_weights": Path(cfg.inference.weights).name,
        "hyperparameters": {"hidden_layers": list(HIDDEN), "learning_rate": LEARNING_RATE,
                            "weight_decay": WEIGHT_DECAY, "dropout": DROPOUT, "batch_size": BATCH_SIZE,
                            "epochs": args.epochs, "window_frames": WINDOW, "optimizer": "Adam",
                            "loss": "binary cross-entropy, weighted for class balance",
                            "augmentation": "left-right mirroring"},
        "data": {"train_scenarios": train_s, "val_scenarios": list(mcfd.VAL_SCENARIOS),
                 "cameras": list(mcfd.TRAIN_CAMERAS), "train_windows": int(len(y_tr)),
                 "train_down": int(y_tr.sum()), "val_windows": int(len(y_va)), "val_down": int(y_va.sum())},
        "threshold": threshold,
        "validation_by_activity": by_activity,
        "history": history,
    }
    out.with_suffix(".json").write_text(json.dumps(card, indent=2), encoding="utf-8")
    print(f"saved {out} and {out.with_suffix('.json').name}")


# ================================================================================================
# Command line
# ================================================================================================

COMMANDS = {"pose-labels": pose_labels_main, "finetune": finetune_main, "stage-b": stage_b_main}


def main() -> None:
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        print(__doc__)
        sys.exit(2)
    command = sys.argv.pop(1)
    sys.argv[0] = f"python -m model_finetuning.finetune {command}"
    COMMANDS[command]()


if __name__ == "__main__":
    main()
