"""ML service entry point: receives camera streams from stream-hub and detects falls.

    python main.py                # run headless
    python main.py --show         # also open a window with annotated video
"""

import argparse
import logging
import socket
import threading

import cv2
import numpy as np

import config
from ingest.protocol import MAX_NALU_LEN, ProtocolError, read_handshake, read_message
from pipeline import CameraPipeline
from sinks.jsonl import JsonlSink

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


def show_loop() -> None:
    """OpenCV windows must be driven from the main thread."""
    blank = np.zeros((360, 640, 3), dtype=np.uint8)
    cv2.putText(blank, "Waiting for cameras...", (150, 180), cv2.FONT_HERSHEY_SIMPLEX, 0.8,
                (200, 200, 200), 2, cv2.LINE_AA)
    while True:
        with pipelines_lock:
            frames = [p.latest_annotated for p in pipelines.values() if p.latest_annotated is not None]
        if frames:
            frames = [cv2.resize(f, (640, 360)) for f in frames]
            cols = min(len(frames), 3)
            while len(frames) % cols:
                frames.append(np.zeros_like(frames[0]))
            grid = np.vstack([np.hstack(frames[i:i + cols]) for i in range(0, len(frames), cols)])
        else:
            grid = blank
        cv2.imshow("ml-service", grid)
        if cv2.waitKey(30) & 0xFF == ord("q"):
            return


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--config", default="config.yaml")
    parser.add_argument("--show", action="store_true", help="display annotated video")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    cfg = config.load(args.config)
    cfg.show = args.show
    sink = JsonlSink(cfg.output_dir)
    server = serve(cfg, sink)

    try:
        if cfg.show:
            show_loop()
        else:
            threading.Event().wait()
    except KeyboardInterrupt:
        pass
    finally:
        server.close()
        cv2.destroyAllWindows()
        log.info("stopped")


if __name__ == "__main__":
    main()
