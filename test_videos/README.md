# test_videos

Two short clips of real falls, used in two places:

- **`test.mp4`** is streamed on a loop by the `test-camera` service in the root
  `docker-compose.yml`, as `rtsp://test-camera:8554/test`: a fake IP camera for testing the
  whole system without a real camera.
- **`test.mp4` and `fall.mp4`** are the "recorded videos" of the ml-service benchmark
  (`ml-service/evaluation/videos.yaml` holds their ground truth).

Both come from the Multiple Cameras Fall Dataset (held-out test scenarios, so never used for
training). The videos are git-ignored; make them once with your copy of the dataset:

```powershell
cd ml-service
.venv\Scripts\python setup_and_tools\fake_cameras\make_test_videos.py --mcfd "C:\datasets\Fall Dataset"
```

Any other clip FFmpeg can read also works as `test.mp4` for the test camera (the benchmark's
ground truth then no longer matches it).
