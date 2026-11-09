"""Stands in for stream-hub: encodes a video file or webcam to H.264 and sends it to
ml-service using the same wire protocol as stream-hub (internal/hub/ai_worker.go),
including the per-picture PTS that protocol now requires.

    python tools/send_video.py --source 0 --tenant-id demo-facility          # webcam
    python tools/send_video.py --source fall.mp4 --tenant-id demo-facility --loop

Pass --tenant-id whenever ml-service's config has tenant_in_handshake: true, which the
shipped config.yaml now defaults to for every tcp-reading section.
"""

import argparse
import socket
import sys
import threading
import time
from fractions import Fraction
from pathlib import Path

import av
import cv2

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ingest.protocol import read_message, write_frame, write_message  # noqa: E402


def make_encoder(width: int, height: int, fps: int) -> av.CodecContext:
    name = "libx264" if "libx264" in av.codecs_available else "h264"
    enc = av.CodecContext.create(name, "w")
    enc.width, enc.height = width - width % 2, height - height % 2
    enc.pix_fmt = "yuv420p"
    enc.time_base = Fraction(1, fps)
    enc.framerate = Fraction(fps, 1)
    enc.gop_size = fps * 2
    enc.max_b_frames = 0
    if name == "libx264":
        enc.options = {"preset": "ultrafast", "tune": "zerolatency"}
    enc.open()
    return enc


def drain_results(sock: socket.socket, verbose: bool) -> None:
    """Reads and discards ml-service's results (detections, incidents, recording
    commands, snapshots) so its write buffer never fills up and blocks ml-service.
    Runs until the connection closes.
    """
    try:
        while (payload := read_message(sock, 16 << 20)) is not None:
            if verbose:
                kind = payload[:80]
                print(f"  <- {len(payload)} bytes: {kind!r}", file=sys.stderr)
    except OSError:
        pass


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source", default="0", help="webcam index or video file path")
    parser.add_argument("--camera-id", default="test-cam-1")
    parser.add_argument("--tenant-id", help="send tenant_id first (tenant_in_handshake: true)")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9999)
    parser.add_argument("--loop", action="store_true", help="restart a video file when it ends")
    parser.add_argument("--show-results", action="store_true", help="print ml-service's results as they arrive")
    args = parser.parse_args()

    source = int(args.source) if args.source.isdigit() else args.source
    cap = cv2.VideoCapture(source)
    if not cap.isOpened():
        sys.exit(f"cannot open source {args.source!r}")
    fps = int(round(cap.get(cv2.CAP_PROP_FPS))) or 30
    width, height = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    enc = make_encoder(width, height, fps)

    sock = socket.create_connection((args.host, args.port))
    if args.tenant_id:
        write_message(sock, args.tenant_id.encode())
    write_message(sock, args.camera_id.encode())
    print(f"sending {args.source} as [{args.camera_id}] at {enc.width}x{enc.height}@{fps} using {enc.name}")

    threading.Thread(target=drain_results, args=(sock, args.show_results), daemon=True).start()

    pts = 0
    next_frame = time.monotonic()
    try:
        while True:
            ok, bgr = cap.read()
            if not ok:
                if args.loop and not isinstance(source, int):
                    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                    continue
                break
            # One PTS (Unix epoch ms) per picture, like the gateway: every NALU this
            # picture encodes to shares it, so ml-service can group them back together.
            frame_pts = int(time.time() * 1000)
            frame = av.VideoFrame.from_ndarray(bgr[: enc.height, : enc.width], format="bgr24")
            frame = frame.reformat(format="yuv420p")
            frame.pts = pts
            pts += 1
            for packet in enc.encode(frame):
                write_frame(sock, frame_pts, bytes(packet))

            if not isinstance(source, int):  # pace files at real time; webcams pace themselves
                next_frame += 1 / fps
                time.sleep(max(0.0, next_frame - time.monotonic()))
    except (KeyboardInterrupt, BrokenPipeError, ConnectionError):
        pass
    finally:
        cap.release()
        sock.close()


if __name__ == "__main__":
    main()