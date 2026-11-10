# Models

Every model file ml-service can run with. Two kinds, chosen separately in `config.yaml`:

| Kind | What it does | Chosen by | Files |
|---|---|---|---|
| **Pose model** (YOLO26-pose) | Finds every person and their 17 body points | `inference.weights` | `*.pt` |
| **Fall classifier** | Decides from the body points whether someone is down | `fall.classifier` (`rules` or `learned`) and `fall.learned_model` | `stage_b*.npz` |

| File | Kind | Where it comes from |
|---|---|---|
| `yolo26n-pose.pt` | pose model | Ultralytics' standard model (the default in `config.yaml`) |
| `yolo26n-pose-finetuned-mcfDataset-111026.pt` | pose model | `python -m model_finetuning.finetune finetune`: the standard model fine-tuned on the Multiple Cameras Fall Dataset (people lying on the floor, ceiling cameras), trained 10 Nov 2026 |
| `stage_b.npz` | fall classifier | `python -m model_finetuning.finetune stage-b`: the learned classifier, trained on the pose model's output |
| (none) | fall classifier | `fall.classifier: rules`: the hand-written rules in `app/detection/fall_detection.py`, no file needed |

How well each combination works is in [DETECTION_CHANGELOG.md](../DETECTION_CHANGELOG.md).

**Naming**, so a list of available models can be read from this folder (e.g. for a model picker
in the frontend): pose models are `yolo26<size>-pose.pt` (standard) or `yolo26<size>-pose-finetuned-<dataset>-<mmddyy>.pt`
(fine-tuned: on which dataset, and the date it was trained; `mcfDataset` = Multiple Cameras Fall Dataset), fall
classifiers are `stage_b[-<variant>].npz`. A learned classifier is trained on one pose model's
output, so its file records which one (`version` inside the .npz, e.g. `0.1.0+yolo26n-pose-finetuned-mcfDataset-111026`).

The model files here are committed to git (a few MB each), so every teammate and the offline
course server have the same models; `.pt` files anywhere else (e.g. training checkpoints) stay
git-ignored. Everything in this folder is copied into the Docker image. YOLO26 models and models
fine-tuned from them come under Ultralytics' AGPL-3.0 licence.
