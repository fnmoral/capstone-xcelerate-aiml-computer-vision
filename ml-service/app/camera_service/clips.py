"""Dashcam-style incident clips: a few seconds before the fall until shortly after it ends.

Each camera keeps a short loop of its *compressed* video in memory (the H.264 / H.265
packets stream-hub sends, ~1-2 MB for 15 s), like a dashcam. When a fall is confirmed the
loop becomes the start of a recording, which keeps going until post_roll_s after the
person is back up (or out of view), capped at max_s. Nothing is decoded or stored while
nothing happens.

The finished recording is turned into an H.264 MP4 (scaled to max_width) by one
background thread, so every browser can play it even when the camera sends H.265. That
thread only uses PyAV, never PyTorch. It also deletes old clips: older than
retention_days, then oldest first while the folder is over max_total_gb.

Clips are written as <output dir>/clips/<incident id>_<camera id>.mp4.
"""

import logging
import queue
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from fractions import Fraction
from pathlib import Path

import av

log = logging.getLogger(__name__)


@dataclass(slots=True)
class ClipConfig:
    enabled: bool = True
    pre_roll_s: float = 15.0      # video kept from before the fall
    post_roll_s: float = 10.0     # and after the person is back up / out of view
    max_s: float = 120.0          # longest clip
    max_width: int = 1280         # clips are scaled down to this width (never up)
    crf: int = 28                 # H.264 quality: lower = better and bigger (18-32)
    buffer_mb: float = 64.0       # cap on each camera's in-memory loop
    retention_days: float = 30.0  # delete clips older than this; 0 = keep
    max_total_gb: float = 10.0    # then oldest first while the clips folder is bigger; 0 = no cap


def _strip(nalu: bytes) -> bytes:
    if nalu.startswith(b"\x00\x00\x00\x01"):
        return nalu[4:]
    if nalu.startswith(b"\x00\x00\x01"):
        return nalu[3:]
    return nalu


def nal_kind(nalu: bytes, codec: str) -> tuple[bool, bool, bool]:
    """(parameter set, keyframe, first slice of a picture) for one NALU."""
    n = _strip(nalu)
    if not n:
        return False, False, False
    if codec == "hevc":
        t = (n[0] >> 1) & 0x3F
        first = t <= 31 and len(n) > 2 and bool(n[2] & 0x80)  # first_slice_segment_in_pic_flag
        return 32 <= t <= 34, 16 <= t <= 23, first
    t = n[0] & 0x1F
    first = t in (1, 5) and len(n) > 1 and bool(n[1] & 0x80)     # first_mb_in_slice == 0
    return t in (7, 8), t == 5, first


@dataclass(slots=True)
class ClipJob:
    incident_id: str
    camera_id: str
    tenant_id: str
    codec: str
    started_at: float              # wall clock of the first packet
    ended_at: float
    nalus: list[bytes] = field(default_factory=list)
    pictures: int = 0              # frames in the clip, for the frame rate


class _Recording:
    __slots__ = ("job", "stop_at", "hard_end")

    def __init__(self, job: ClipJob, hard_end: float):
        self.job = job
        self.stop_at: float | None = None
        self.hard_end = hard_end


class ClipRecorder:
    """One camera's dashcam loop and its running recordings. Thread-safe: feed() runs on the
    camera's reader thread, start() / stop() on the main thread."""

    def __init__(self, camera_id: str, tenant_id: str, cfg: ClipConfig, writer: "ClipWriter"):
        self.camera_id = camera_id
        self.tenant_id = tenant_id
        self.cfg = cfg
        self.writer = writer
        self._lock = threading.Lock()
        self._buf: deque[tuple[float, bytes, bool, bool]] = deque()  # (time, nalu, keyframe, first slice)
        self._keys: deque[float] = deque()                           # times of the keyframes in _buf
        self._bytes = 0
        self._params: dict[int, bytes] = {}
        self._codec: str | None = None
        self._active: dict[str, _Recording] = {}

    @property
    def buffered_bytes(self) -> int:
        return self._bytes

    def feed(self, nalu: bytes, codec: str | None, now: float | None = None) -> None:
        if codec is None:
            return
        now = time.time() if now is None else now
        is_param, is_key, first = nal_kind(nalu, codec)
        with self._lock:
            if codec != self._codec:  # first packet, or the camera changed codec: start over
                self._buf.clear(); self._keys.clear(); self._params.clear(); self._bytes = 0
                self._codec = codec
            if is_param:
                self._params[_strip(nalu)[0]] = nalu
            self._buf.append((now, nalu, is_key, first))
            self._bytes += len(nalu)
            if is_key:
                self._keys.append(now)
            self._trim(now)
            for incident_id, rec in list(self._active.items()):
                rec.job.nalus.append(nalu)
                rec.job.pictures += first
                rec.job.ended_at = now
                if (rec.stop_at is not None and now >= rec.stop_at) or now >= rec.hard_end:
                    self._finish(incident_id)

    def _trim(self, now: float) -> None:
        """Keep pre_roll_s of video, starting at a keyframe so the clip can be decoded."""
        cutoff = now - self.cfg.pre_roll_s
        cap = self.cfg.buffer_mb * 1024 * 1024
        while len(self._keys) >= 2 and (self._keys[1] <= cutoff or self._bytes > cap):
            self._drop_until(self._keys[1])
            self._keys.popleft()
        if not self._keys:  # nothing decodable yet: don't let it grow
            while self._buf and (self._buf[0][0] < cutoff or self._bytes > cap):
                self._bytes -= len(self._buf.popleft()[1])

    def _drop_until(self, key_time: float) -> None:
        while self._buf and not (self._buf[0][2] and self._buf[0][0] == key_time):
            self._bytes -= len(self._buf.popleft()[1])

    def start(self, incident_id: str, now: float | None = None) -> None:
        """A fall was confirmed on this camera: start a clip with the loop's video."""
        if not self.cfg.enabled:
            return
        now = time.time() if now is None else now
        with self._lock:
            if incident_id in self._active or self._codec is None:
                return
            items = list(self._buf)
            first_key = next((i for i, item in enumerate(items) if item[2]), len(items))
            items = items[first_key:]
            job = ClipJob(incident_id, self.camera_id, self.tenant_id, self._codec,
                          started_at=items[0][0] if items else now, ended_at=now)
            job.nalus = [self._params[k] for k in sorted(self._params)] + [n for _, n, _, _ in items]
            job.pictures = sum(f for *_, f in items)
            self._active[incident_id] = _Recording(job, hard_end=job.started_at + self.cfg.max_s)
            log.info("[%s] recording clip for incident %s (%.0f s before the fall)", self.camera_id,
                     incident_id, now - job.started_at)

    def stop(self, incident_id: str, now: float | None = None) -> None:
        """The person is back up / out of view: finish post_roll_s from now."""
        now = time.time() if now is None else now
        with self._lock:
            rec = self._active.get(incident_id)
            if rec is not None and rec.stop_at is None:
                rec.stop_at = now + self.cfg.post_roll_s

    def close(self) -> None:
        """The camera disconnected: save what was recorded so far."""
        with self._lock:
            for incident_id in list(self._active):
                self._finish(incident_id)

    def _finish(self, incident_id: str) -> None:
        rec = self._active.pop(incident_id)
        self.writer.submit(rec.job)


class ClipWriter:
    """Encodes finished recordings to MP4 on a background thread and prunes old clips.

    on_saved(job, key, seconds) is called after each clip is written (e.g. to store the key
    in the database).
    """

    PRUNE_EVERY_S = 3600

    def __init__(self, out_dir: str, cfg: ClipConfig, on_saved=None):
        self.dir = Path(out_dir) / "clips"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.cfg = cfg
        self.on_saved = on_saved
        self._queue: queue.Queue[ClipJob | None] = queue.Queue()
        self._thread = threading.Thread(target=self._run, name="clip-writer", daemon=True)
        self._thread.start()

    def submit(self, job: ClipJob) -> None:
        self._queue.put(job)

    def close(self, timeout: float = 30.0) -> None:
        self._queue.put(None)
        self._thread.join(timeout)

    def _run(self) -> None:
        self.prune()
        last_prune = time.monotonic()
        while True:
            try:
                job = self._queue.get(timeout=60)
            except queue.Empty:
                job = False
            if job is None:
                return
            if job:
                try:
                    key, seconds = self.write(job)
                    if key and self.on_saved:
                        self.on_saved(job, key, seconds)
                except Exception:
                    log.exception("[%s] clip for incident %s failed", job.camera_id, job.incident_id)
            if time.monotonic() - last_prune > self.PRUNE_EVERY_S:
                self.prune()
                last_prune = time.monotonic()

    def write(self, job: ClipJob) -> tuple[str | None, float]:
        """Decode the recording and encode it as H.264 MP4. Returns (key, seconds)."""
        seconds = max(job.ended_at - job.started_at, 0.1)
        if job.pictures < 2:
            log.warning("[%s] clip for incident %s has no video; not saved", job.camera_id, job.incident_id)
            return None, 0.0
        fps = Fraction(job.pictures / seconds).limit_denominator(100)
        name = f"{job.incident_id}_{job.camera_id}.mp4"
        path, tmp = self.dir / name, self.dir / (name + ".part")

        decoder = av.CodecContext.create(job.codec, "r")
        out = av.open(str(tmp), "w", format="mp4", options={"movflags": "+faststart"})
        stream = None
        count = 0
        try:
            for nalu in job.nalus:
                data = nalu if nalu.startswith((b"\x00\x00\x00\x01", b"\x00\x00\x01")) else b"\x00\x00\x00\x01" + nalu
                try:
                    frames = [f for p in decoder.parse(data) for f in decoder.decode(p)]
                except av.FFmpegError:
                    continue  # e.g. slices before the first keyframe
                for frame in frames:
                    if stream is None:
                        stream, size = self._open_stream(out, frame, fps)
                    img = frame.reformat(width=size[0], height=size[1], format="yuv420p")
                    img.pts = count
                    count += 1
                    for packet in stream.encode(img):
                        out.mux(packet)
            if stream is not None:
                for packet in stream.encode(None):
                    out.mux(packet)
        finally:
            out.close()
        if count == 0:
            tmp.unlink(missing_ok=True)
            log.warning("[%s] clip for incident %s: nothing decodable", job.camera_id, job.incident_id)
            return None, 0.0
        tmp.replace(path)
        log.info("[%s] clip saved: %s (%d frames, %.0f s, %.1f MB)", job.camera_id, name, count, seconds,
                 path.stat().st_size / 1e6)
        return f"clips/{name}", round(count / float(fps), 1)

    def _open_stream(self, out, frame, fps: Fraction):
        w, h = frame.width, frame.height
        if w > self.cfg.max_width:
            h = round(h * self.cfg.max_width / w)
            w = self.cfg.max_width
        size = (w - w % 2, h - h % 2)  # H.264 4:2:0 needs even sizes
        stream = out.add_stream("libx264", rate=fps)
        stream.width, stream.height = size
        stream.pix_fmt = "yuv420p"
        stream.options = {"preset": "veryfast", "crf": str(self.cfg.crf), "g": str(max(int(fps * 2), 2))}
        return stream, size

    def prune(self) -> None:
        """Delete clips past retention_days, then the oldest while over max_total_gb."""
        files = sorted(self.dir.glob("*.mp4"), key=lambda p: p.stat().st_mtime)
        removed = 0
        if self.cfg.retention_days > 0:
            cutoff = time.time() - self.cfg.retention_days * 86400
            while files and files[0].stat().st_mtime < cutoff:
                files.pop(0).unlink(missing_ok=True)
                removed += 1
        if self.cfg.max_total_gb > 0:
            total = sum(p.stat().st_size for p in files)
            while files and total > self.cfg.max_total_gb * 1e9:
                f = files.pop(0)
                total -= f.stat().st_size
                f.unlink(missing_ok=True)
                removed += 1
        for part in self.dir.glob("*.part"):  # left over from a crash mid-write
            if part.stat().st_mtime < time.time() - 600:
                part.unlink(missing_ok=True)
        if removed:
            log.info("clips: deleted %d old clip(s)", removed)
