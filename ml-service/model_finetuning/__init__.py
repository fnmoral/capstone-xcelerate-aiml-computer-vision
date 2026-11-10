"""Improving the model with the Multiple Cameras Fall Dataset (finished models go into models/).

finetune.py   1 pose labels: a big teacher model labels the training frames
              2 fine-tune the pose model on them        -> models/yolo26n-pose-finetuned-mcfDataset-<mmddyy>.pt
              3 train the Stage B fall classifier        -> models/stage_b.npz
              python -m model_finetuning.finetune <pose-labels | finetune | stage-b> --mcfd <dataset folder>
report.py     Excel + CSV + charts: training per epoch, hyperparameters, before vs after
              python -m model_finetuning.report --mcfd <dataset folder> --results <before> <after>...
reports/      the latest report (fine_tuning_report.xlsx, *.csv, *.png)
"""
