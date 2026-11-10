# Models

Every model file ml-service can run with. Two kinds, chosen separately in `config.yaml`:

| Kind | What it does | Chosen by | Files |
|---|---|---|---|
| **Pose model** (YOLO26-pose) | Finds every person and their 17 body points | `inference.weights` | `*.pt` |
| **Fall classifier** | Decides from the body points whether someone is down | `fall.classifier` (`rules` or `learned`) and `fall.learned_model` | `stage_b*.npz` |

| File | Kind | Where it comes from |
|---|---|---|
| `yolo26n-pose.pt` | pose model | Ultralytics' standard model, downloaded automatically (not in git) |
| `yolo26n-pose-mcfd.pt` | pose model | `python -m model_finetuning.finetune finetune`: the standard model fine-tuned on the Multiple Cameras Fall Dataset (people lying on the floor, ceiling cameras) |
| `stage_b.npz` | fall classifier | `python -m model_finetuning.finetune stage-b`: the learned classifier, trained on the pose model's output |
| (none) | fall classifier | `fall.classifier: rules`: the hand-written rules in `detection/fall_detection.py`, no file needed |

How well each combination works is in [DETECTION_CHANGELOG.md](../DETECTION_CHANGELOG.md).

**Naming**, so a list of available models can be read from this folder (e.g. for a model picker
in the frontend): pose models are `yolo26<size>-pose[-<what it was fine-tuned on>].pt`, fall
classifiers are `stage_b[-<variant>].npz`. A learned classifier is trained on one pose model's
output, so its file records which one (`version` inside the .npz, e.g. `0.1.0+yolo26n-pose-mcfd`).

`.pt` files are git-ignored (they are large); everything in this folder is copied into the
Docker image.
