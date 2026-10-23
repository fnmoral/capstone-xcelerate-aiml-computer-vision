"""ML service entry point: detects falls in camera video.

config.yaml has a dev and a prod section; `prod_mode` picks one (see CONFIG.md). In dev,
stream-hub (tcp), webcams, RTSP cameras and video files all go through the same pipeline.
Prod accepts IP cameras only (tcp, rtsp). Flags override the file for a quick test:

    python main.py                                  # use config.yaml
    python main.py --prod / --dev                   # force a mode
    python main.py --webcam 0                       # this PC's first webcam
    python main.py --webcam 0 --tcp                 # a webcam next to the stream-hub cameras
    python main.py --rtsp rtsp://user:pw@cam/stream # an IP camera, without the Go services
    python main.py --video fall.mp4                 # a local video file
    python main.py --show / --no-show               # force the preview window on or off

Environment: ML_CONFIG picks the config file, ML_PROD_MODE=true forces prod (the container sets both).
"""

import argparse
import logging
import os
import socket
import sys
import threading
import time
from pathlib import Path

import cv2
import numpy as np

import config
from fall.zones import IncidentAggregator
from ingest.protocol import MAX_NALU_LEN, ProtocolError, read_handshake, read_message
from pipeline import CameraPipeline
from sinks import FanoutSink, SnapshotStore
from sinks.jsonl import JsonlSink
from viewer import Viewer, ViewerSink
from vision.pose import PoseTracker, describe_device

log = logging.getLogger("ml-service")

RECONNECT_SECONDS = 3.0
RTSP_TIMEOUT_MS = 5000  # OpenCV's default is ~30 s, too slow to notice a dead camera

pipelines: dict[str, CameraPipeline] = {}
pipelines_lock = threading.Lock()
# Shared by all cameras so overlapping cameras raise one incident; set in main().
aggregator = IncidentAggregator({}, 0.0)
snapshots: SnapshotStore | None = None


def new_pipeline(tenant_id: str, camera_id: str, cfg: config.Config, sink: FanoutSink) -> CameraPipeline:
    return CameraPipeline(tenant_id, camera_id, cfg, sink, aggregator, snapshots)


def build_sink(cfg: config.Config):
    """The output sinks from output.sinks. Returns (fanout, postgres sink or None)."""
    sinks = []
    pg = None
    if "jsonl" in cfg.sinks:
        sinks.append(JsonlSink(cfg.output_dir))
    if "postgres" in cfg.sinks:
        from sinks.postgres import PostgresSink  # psycopg only needed when the database is used

        pg = PostgresSink(cfg.database_url, cfg.database_connect_timeout_s)
        sinks.append(pg)
        log.info("writing results to PostgreSQL at %s", cfg.database_url.split("@")[-1])
    return FanoutSink(sinks), pg


def load_db_zones(pg) -> dict[str, list[str]] | None:
    try:
        return pg.load_zones()
    except Exception as e:
        log.warning("could not load zones from the database (%s)", str(e).strip().splitlines()[0])
        return None


def refresh_zones(cfg: config.Config, pg, stop: threading.Event, every_s: float = 60.0) -> None:
    """Zones are edited in the frontend's Cameras page; pick up changes without a restart."""
    current = None
    while not stop.wait(every_s):
        db_zones = load_db_zones(pg)
        if db_zones is None:
            continue
        zones = merge_zones(cfg.zones, db_zones)
        if zones != current:
            current = zones
            aggregator.set_zones(zones)
            log.info("zones reloaded from the database: %s", ", ".join(zones) or "none")


def merge_zones(file_zones: dict[str, list[str]], db_zones: dict[str, list[str]]) -> dict[str, list[str]]:
    """config.yaml zones win; a database zone keeps only cameras not already zoned in the file."""
    zones = {name: list(cams) for name, cams in file_zones.items()}
    taken = {cam for cams in file_zones.values() for cam in cams}
    for name, cams in db_zones.items():
        free = [c for c in cams if c not in taken]
        if len(free) < len(cams):
            log.warning("zone [%s] from the database: cameras also zoned in config.yaml keep their file zone", name)
        if free:
            zones.setdefault(name, []).extend(free)
    return zones


def register(pipeline: CameraPipeline) -> bool:
    with pipelines_lock:
        if pipeline.camera_id in pipelines:
            log.error("camera [%s] is already connected; ignoring the second one", pipeline.camera_id)
            return False
        pipelines[pipeline.camera_id] = pipeline
        return True


def unregister(pipeline: CameraPipeline) -> None:
    with pipelines_lock:
        if pipelines.get(pipeline.camera_id) is not pipeline:
            return
        del pipelines[pipeline.camera_id]
    pipeline.close()  # open incidents on this camera become unresolved


# ---------- tcp: cameras streamed by stream-hub ----------

def handle_connection(conn: socket.socket, addr, cfg: config.Config, sink: JsonlSink) -> None:
    camera_id = "?"
    pipeline = None
    try:
        tenant_id, camera_id = read_handshake(conn, cfg.tenant_in_handshake, cfg.default_tenant_id)
        log.info("camera [%s] tenant [%s] connected from %s", camera_id, tenant_id, addr)
        pipeline = new_pipeline(tenant_id, camera_id, cfg, sink)
        if not register(pipeline):
            return
        while (nalu := read_message(conn, MAX_NALU_LEN)) is not None:
            pipeline.handle_nalu(nalu)
    except (ProtocolError, ConnectionError, UnicodeDecodeError) as e:
        log.warning("camera [%s] connection error: %s", camera_id, e)
    finally:
        conn.close()
        if pipeline is not None:
            unregister(pipeline)
        log.info("camera [%s] disconnected", camera_id)


def serve(cfg: config.Config, sink: JsonlSink) -> socket.socket:
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((cfg.host, cfg.port))
    server.listen()
    log.info("listening for stream-hub on %s:%d", cfg.host, cfg.port)

    def accept_loop():
        while True:
            try:
                conn, addr = server.accept()
            except OSError:
                return
            threading.Thread(target=handle_connection, args=(conn, addr, cfg, sink), daemon=True).start()

    threading.Thread(target=accept_loop, daemon=True).start()
    return server


# ---------- webcam / rtsp / file: read directly ----------

def open_capture(src: config.SourceConfig) -> cv2.VideoCapture:
    match src.type:
        case "webcam":
            # DirectShow opens Windows webcams much faster than the default backend.
            backend = cv2.CAP_DSHOW if sys.platform == "win32" else cv2.CAP_ANY
            cap = cv2.VideoCapture(src.index, backend)
        case "rtsp":
            cap = cv2.VideoCapture(src.url, cv2.CAP_FFMPEG, [
                cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, RTSP_TIMEOUT_MS,
                cv2.CAP_PROP_READ_TIMEOUT_MSEC, RTSP_TIMEOUT_MS,
            ])
        case _:
            cap = cv2.VideoCapture(src.path)
    if src.type != "file":
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)  # always process the newest frame
    return cap


def describe_source(src: config.SourceConfig) -> str:
    match src.type:
        case "webcam":
            return f"webcam {src.index}"
        case "rtsp":
            return src.url.split("@")[-1]  # hide credentials in logs
        case _:
            return src.path


def run_capture(src: config.SourceConfig, cfg: config.Config, sink: JsonlSink, stop: threading.Event) -> None:
    """Feeds one webcam, RTSP camera or video file into its pipeline.

    Webcams and RTSP cameras behave like stream-hub cameras: if they drop out, the camera
    disappears and is retried every few seconds. A file plays once, or loops.
    """
    label = describe_source(src)
    pipeline = new_pipeline(src.tenant_id, src.camera_id, cfg, sink)
    if not register(pipeline):
        return

    looped = False
    try:
        while not stop.is_set():
            cap = open_capture(src)
            if not cap.isOpened():
                cap.release()
                if src.type == "file":
                    log.error("cannot open %s", label)
                    return
                log.warning("camera [%s] cannot open %s; retrying in %.0fs", src.camera_id, label, RECONNECT_SECONDS)
                stop.wait(RECONNECT_SECONDS)
                continue

            fps = cap.get(cv2.CAP_PROP_FPS)
            if fps <= 0:  # some webcam drivers report -1
                fps = 30.0
            if not looped:
                log.info("camera [%s] reading %s", src.camera_id, label)
            next_frame = time.monotonic()
            try:
                while not stop.is_set():
                    ok, frame = cap.read()
                    if not ok:
                        break
                    pipeline.submit(frame)
                    if src.type == "file":  # play files at real speed; live sources pace themselves
                        next_frame += 1 / fps
                        time.sleep(max(0.0, next_frame - time.monotonic()))
            finally:
                cap.release()

            if stop.is_set():
                return
            if src.type == "file":
                if not src.loop:
                    log.info("camera [%s] %s ended", src.camera_id, label)
                    return
                looped = True
                continue
            log.warning("camera [%s] lost %s; reconnecting in %.0fs", src.camera_id, label, RECONNECT_SECONDS)
            stop.wait(RECONNECT_SECONDS)
    finally:
        unregister(pipeline)


# ---------- model and main loop ----------

def warm_up(cfg: config.Config) -> None:
    """Load the model and run it once, so CUDA start-up (several seconds) happens before cameras open."""
    inf = cfg.inference
    start = time.perf_counter()
    tracker = PoseTracker(inf.weights, inf.device, inf.conf, inf.imgsz, inf.tracker, inf.half)
    tracker(np.zeros((inf.imgsz, inf.imgsz, 3), dtype=np.uint8))
    log.info("model %s ready on %s%s in %.1fs", Path(inf.weights).name, describe_device(tracker.device),
             " (FP16)" if tracker.half else "", time.perf_counter() - start)


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


MIN_STATS_WINDOW_S = 10.0  # don't judge a camera on its first few seconds (model start-up)


def log_stats(active: list[CameraPipeline], target_fps: float) -> None:
    """One line per camera: frames received and analysed per second, and average model time."""
    parts = []
    behind = []
    for p in active:
        frames_in, analysed, model_ms, seconds = p.take_stats()
        fps = analysed / seconds
        avg_ms = model_ms / analysed if analysed else 0.0
        parts.append(f"{p.camera_id} in={frames_in / seconds:.1f}fps analysed={fps:.1f}fps model={avg_ms:.0f}ms")
        # Sources slower than target_fps can't reach it; only flag cameras that have frames to spare.
        if seconds >= MIN_STATS_WINDOW_S and frames_in / seconds >= target_fps and fps < 0.8 * target_fps:
            behind.append(p.camera_id)
    log.info("stats: %d camera(s) | %s", len(active), " | ".join(parts) or "none connected")
    if behind:
        log.warning("analysing fewer than %.0f fps on %s; the GPU is saturated. Lower inference.target_fps "
                    "or use a faster GPU/model", target_fps, ", ".join(behind))


def main_loop(stop: threading.Event, show: bool, capture_threads: list[threading.Thread], uses_tcp: bool,
              stats_interval_s: float, target_fps: float) -> None:
    """Runs the model for every camera, and the preview window. Both must stay on the main thread."""
    last_render = 0.0
    last_stats = time.monotonic()
    while not stop.is_set():
        if stats_interval_s > 0 and time.monotonic() - last_stats >= stats_interval_s:
            with pipelines_lock:
                active = list(pipelines.values())
            last_stats = time.monotonic()
            log_stats(active, target_fps)

        if not uses_tcp and not any(t.is_alive() for t in capture_threads):
            log.info("all sources have ended")
            return

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


def detection_settings(cfg: config.Config) -> dict:
    """Read-only summary of the detection settings, shown by the frontend."""
    r, m = cfg.rules, cfg.monitor
    return {
        "mode": "prod" if cfg.prod_mode else "dev",
        "model": Path(cfg.inference.weights).name,
        "device": str(cfg.inference.device),
        "target_fps": cfg.inference.target_fps,
        "person_confidence": cfg.inference.conf,
        "rules": {
            "lying_torso_angle_deg": r.lying_torso_angle_deg,
            "falling_torso_angle_deg": r.falling_torso_angle_deg,
            "lying_aspect_ratio": r.lying_aspect_ratio,
            "fall_velocity": r.fall_velocity,
            "min_keypoint_conf": cfg.rules_min_kpt_conf,
        },
        "incidents": {
            "confirm_seconds": m.confirm_seconds,
            "recover_seconds": m.recover_seconds,
            "lost_track_seconds": m.lost_track_seconds,
            "high_after_seconds": m.high_after_seconds,
            "critical_after_seconds": m.critical_after_seconds,
            "merge_window_seconds": cfg.merge_window_s,
        },
        "zones": {name: cams for name, cams in aggregator.zones().items()},
    }


def has_display() -> bool:
    if sys.platform != "linux":
        return True
    return bool(os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))


def main() -> None:
    default_config = os.environ.get("ML_CONFIG") or str(Path(__file__).resolve().parent / "config.yaml")
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--config", default=default_config)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--prod", dest="prod_mode", action="store_true", default=None,
                      help="production mode: IP cameras only")
    mode.add_argument("--dev", dest="prod_mode", action="store_false", help="dev / prototyping mode")
    parser.add_argument("--webcam", type=int, action="append", metavar="INDEX", help="add a webcam on this PC")
    parser.add_argument("--rtsp", action="append", metavar="URL", help="add an RTSP camera")
    parser.add_argument("--video", action="append", metavar="PATH", help="add a local video file")
    parser.add_argument("--tcp", action="store_true", help="add the stream-hub listener")
    parser.add_argument("--show", action=argparse.BooleanOptionalAction, help="preview window on/off")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    # Prefer TCP for RTSP: UDP drops packets on busy networks, which corrupts frames.
    os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rtsp_transport;tcp")
    try:
        cfg = config.load(args.config, args.prod_mode)
        cli_sources = ([{"type": "webcam", "index": i} for i in args.webcam or []]
                       + [{"type": "rtsp", "url": u} for u in args.rtsp or []]
                       + [{"type": "file", "path": str(Path(p).resolve())} for p in args.video or []]
                       + ([{"type": "tcp"}] if args.tcp else []))
        if cli_sources:
            cfg.sources = config.parse_sources(cli_sources, Path.cwd(), cfg.default_tenant_id)
            cfg.check_mode()
    except ValueError as e:
        log.error("config error: %s", e)
        sys.exit(2)

    log.info("mode: %s, sources: %s", "PROD (IP cameras only)" if cfg.prod_mode else "DEV",
             ", ".join(s.type if s.type == "tcp" else f"{s.type}:{s.camera_id}" for s in cfg.sources))
    if args.show is not None:
        cfg.show = args.show
    if cfg.show and not has_display():
        log.warning("no display found; preview turned off")
        cfg.show = False

    global aggregator, snapshots
    sink, pg = build_sink(cfg)
    db_zones = (load_db_zones(pg) or {}) if pg is not None and cfg.zones_from_db else {}
    zones = merge_zones(cfg.zones, db_zones)
    aggregator = IncidentAggregator(zones, cfg.merge_window_s)
    snapshots = SnapshotStore(cfg.output_dir)
    for name, cams in zones.items():
        log.info("zone [%s]: %s (falls seen by several of these cameras count once)", name, ", ".join(cams))

    stop = threading.Event()
    if pg is not None and cfg.zones_from_db:
        threading.Thread(target=refresh_zones, args=(cfg, pg, stop), name="zone-refresh", daemon=True).start()
    if cfg.viewer_enabled:
        viewer_sink = ViewerSink()
        sink.sinks.append(viewer_sink)

        def current_pipelines() -> dict[str, CameraPipeline]:
            with pipelines_lock:
                return dict(pipelines)

        Viewer(cfg.viewer_host, cfg.viewer_port, cfg.viewer_fps, cfg.viewer_jpeg_quality, current_pipelines,
               viewer_sink, cfg.output_dir, lambda: detection_settings(cfg)).start()

    warm_up(cfg)
    server = serve(cfg, sink) if cfg.uses_tcp else None
    capture_threads = []
    for src in cfg.sources:
        if src.type != "tcp":
            thread = threading.Thread(target=run_capture, args=(src, cfg, sink, stop), daemon=True,
                                      name=f"capture-{src.camera_id}")
            thread.start()
            capture_threads.append(thread)

    try:
        main_loop(stop, cfg.show, capture_threads, cfg.uses_tcp, cfg.stats_interval_s, cfg.inference.target_fps)
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        if server is not None:
            server.close()
        if cfg.show:
            cv2.destroyAllWindows()
        sink.close()  # lets the database writer finish what is queued
        log.info("stopped")


if __name__ == "__main__":
    main()
