"""Running the model on live cameras (everything around app/detection/).

video_input.py      video from stream-hub: TCP messages and decoding into frames
camera_pipeline.py  one camera from frames to incidents; zones merge cameras of one area
results.py          record format, snapshots, JSONL files
database.py         the backend-module PostgreSQL database
app/camera_service/viewer.py           live view in the browser (http://localhost:8000)
"""
