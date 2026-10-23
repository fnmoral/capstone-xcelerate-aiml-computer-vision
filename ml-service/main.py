"""ML service entry point: detects falls in camera video.

The video source is set in config.yaml (source.type), or overridden here:

    python main.py                       # use config.yaml
    python main.py --webcam 0            # this PC's first webcam
    python main.py --video fall.mp4      # a local video file
    python main.py --tcp                 # streams from stream-hub
    python main.py --show / --no-show    # force the preview window on or off
"""

import argparse
import logging
import socket
import sys
import threading
import time
from pathlib import Path

import cv2
import numpy as np

import config
from ingest.protocol import MAX_NALU_LEN, ProtocolError, read_handshake, read_message
from pipeline import CameraPipeline
from sinks.jsonl import JsonlSink
from vision.pose import PoseTracker

log = logging.getLogger("ml-service")

pipelines: dict[str, CameraPipeline] = {}
pipelines_lock = threading.Lock()


def handle_connection(conn: socket.socket, addr, cfg: config.Config, sink: JsonlSink) -> None:
    camera_id = "?"
    try:
        tenant_id, camera_id = read_handshake(conn, cfg.tenant_in_handshake, cfg.default_tenant_id)
        log.info("camera [%s] tenant [%s] connected from %s", camera_id, tenant_id, addr)
        pipeline = CameraPipeline(tenant_id, camera_id, cfg, sink)
        with pipelines_lock:
            pipelines[camera_id] = pipeline

        while (nalu := read_message(conn, MAX_NALU_LEN)) is not None:
            pipeline.handle_nalu(nalu)
    except (ProtocolError, ConnectionError, UnicodeDecodeError) as e:
        log.warning("camera [%s] connection error: %s", camera_id, e)
    finally:
        conn.close()
        with pipelines_lock:
            pipelines.pop(camera_id, None)
        log.info("camera [%s] disconnected", camera_id)


def serve(cfg: config.Config, sink: JsonlSink) -> socket.socket:
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((cfg.host, cfg.port))
    server.listen()
    log.info("listening on %s:%d", cfg.host, cfg.port)

    def accept_loop():
        while True:
            try:
                conn, addr = server.accept()
            except OSError:
                return
            threading.Thread(target=handle_connection, args=(conn, addr, cfg, sink), daemon=True).start()

    threading.Thread(target=accept_loop, daemon=True).start()
    return server


def run_local_source(cfg: config.Config, sink: JsonlSink, stop: threading.Event) -> None:
    """Reads a webcam or video file on this PC and feeds frames straight into the pipeline."""
    src = cfg.source
    is_webcam = src.type == "webcam"
    if is_webcam:
        # DirectShow opens Windows webcams much faster than the default backend.
        backend = cv2.CAP_DSHOW if sys.platform == "win32" else cv2.CAP_ANY
        cap = cv2.VideoCapture(src.webcam_index, backend)
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)  # always process the newest frame
        label = f"webcam {src.webcam_index}"
    else:
        cap = cv2.VideoCapture(src.path)
        label = src.path
    if not cap.isOpened():
        log.error("cannot open %s", label)
        stop.set()
        return

    fps = cap.get(cv2.CAP_PROP_FPS)
    if fps <= 0:  # some webcam drivers report -1
        fps = 30.0
    log.info("reading %s as camera [%s]", label, src.camera_id)
    pipeline = CameraPipeline(cfg.default_tenant_id, src.camera_id, cfg, sink)
    with pipelines_lock:
        pipelines[src.camera_id] = pipeline

    next_frame = time.monotonic()
    try:
        while not stop.is_set():
            ok, frame = cap.read()
            if not ok:
                if not is_webcam and src.loop:
                    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                    continue
                log.info("%s ended", label)
                break
            pipeline.submit(frame)
            if not is_webcam:  # play files at real speed; webcams pace themselves
                next_frame += 1 / fps
                time.sleep(max(0.0, next_frame - time.monotonic()))
    finally:
        cap.release()
        with pipelines_lock:
            pipelines.pop(src.camera_id, None)
        stop.set()


def warm_up(cfg: config.Config) -> None:
    """Load the model and run it once, so CUDA start-up (several seconds) happens before cameras open."""
    inf = cfg.inference
    start = time.perf_counter()
    PoseTracker(inf.weights, inf.device, inf.conf, inf.imgsz, inf.tracker)(
        np.zeros((inf.imgsz, inf.imgsz, 3), dtype=np.uint8))
    log.info("model %s ready in %.1fs", Path(inf.weights).name, time.perf_counter() - start)


def render_grid(active: list[CameraPipeline]) -> np.ndarray:
    frames = [p.latest_annotated for p in active if p.latest_annotated is not None]
    if not frames:
        blank = np.zeros((360, 640, 3), dtype=np.uint8)
        cv2.putText(blank, "Waiting for cameras...", (150, 180), cv2.FONT_HERSHEY_SIMPLEX, 0.8,
                    (200, 200, 200), 2, cv2.LINE_AA)
        return blank
    frames = [cv2.resize(f, (640, 360)) for f in frames]
    cols = min(len(frames), 3)
    while len(frames) % cols:
        frames.append(np.zeros_like(frames[0]))
    return np.vstack([np.hstack(frames[i:i + cols]) for i in range(0, len(frames), cols)])


def main_loop(stop: threading.Event, show: bool) -> None:
    """Runs the model for every camera, and the preview window. Both must stay on the main thread."""
    last_render = 0.0
    while not stop.is_set():
        with pipelines_lock:
            active = list(pipelines.values())

        ran = False
        for pipeline in active:
            try:
                ran |= pipeline.step()
            except Exception:
                log.exception("camera [%s] processing failed", pipeline.camera_id)

        now = time.monotonic()
        if show and (ran or now - last_render > 0.1):
            last_render = now
            cv2.imshow("ml-service", render_grid(active))
            if cv2.waitKey(1) & 0xFF == ord("q"):
                stop.set()
        elif not ran:
            time.sleep(0.005)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--config", default=str(Path(__file__).resolve().parent / "config.yaml"))
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--webcam", type=int, metavar="INDEX", help="read this PC's webcam")
    source.add_argument("--video", metavar="PATH", help="read a local video file")
    source.add_argument("--tcp", action="store_true", help="receive streams from stream-hub")
    parser.add_argument("--show", action=argparse.BooleanOptionalAction, help="preview window on/off")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    cfg = config.load(args.config)
    if args.webcam is not None:
        cfg.source.type, cfg.source.webcam_index = "webcam", args.webcam
    elif args.video:
        cfg.source.type, cfg.source.path = "file", str(Path(args.video).resolve())
    elif args.tcp:
        cfg.source.type = "tcp"
    if args.show is not None:
        cfg.show = args.show

    warm_up(cfg)
    sink = JsonlSink(cfg.output_dir)
    stop = threading.Event()
    server = None
    if cfg.source.type == "tcp":
        server = serve(cfg, sink)
    else:
        threading.Thread(target=run_local_source, args=(cfg, sink, stop), daemon=True).start()

    try:
        main_loop(stop, cfg.show)
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        if server is not None:
            server.close()
        cv2.destroyAllWindows()
        log.info("stopped")


if __name__ == "__main__":
    main()
