"""The live system: everything that runs when you start main.py.

app/config.py         reads config.yaml into typed settings
app/detection/        ★ the machine-learning model: pose_model.py, fall_detection.py
app/camera_service/   video in, the per-camera pipeline, results out (files, database, viewer; stream-hub records the clips)
"""
