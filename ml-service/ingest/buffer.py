"""Holds one camera's newest decoded frame, plus the throughput counters behind
`rates()` / `take_stats()` (used for the periodic stats log line and the Detection
Settings page). One instance per camera; thread-safe.

Submitting and popping the pending frame share a lock with the counters because a
received frame is always counted, and `take_due()` needs to test-and-clear the
pending frame atomically against a concurrent `submit()`.
"""

import threading
import time
from collections import deque

import numpy as np

from ingest.decoder import FrameSampler

RATE_WINDOW_S = 30.0  # rates() averages over this long


def wall_clock_pts() -> int:
    """Current time as a PTS (Unix epoch ms), for sources that don't carry one."""
    return int(time.time() * 1000)


class FrameBuffer:
    def __init__(self):
        self.frames_in = 0
        self.frames_analysed = 0
        self.model_ms = 0.0
        self._stats_since = time.monotonic()
        self._connected_at = self._stats_since
        self._received_times: deque[float] = deque()  # monotonic times, last RATE_WINDOW_S
        self._analysed_times: deque[float] = deque()
        self._receiving = False  # set by the first frame; see _count_received_locked
        self._pending: np.ndarray | None = None
        self._pending_pts: int = 0
        self._lock = threading.Lock()

    def submit(self, frame: np.ndarray, pts: int | None) -> None:
        """Hand over a decoded frame and its PTS (now, if None).
        Only the newest one is kept, so a slow model never falls behind."""
        with self._lock:
            self._pending = frame
            self._pending_pts = pts if pts is not None else wall_clock_pts()
            self._count_received_locked()

    def count_received(self) -> None:
        """A frame arrived but was thrown away before reaching submit() (see
        CameraPipeline.handle_nalu): it still counts for the received-fps figure."""
        with self._lock:
            self._count_received_locked()

    def _count_received_locked(self) -> None:
        """Caller holds _lock.

        The first frame starts the stats and rate windows. Before it the camera was
        only connected (a stream-hub camera waits for its first keyframe, which can
        take several seconds), and counting that wait made a healthy camera look slow
        in the first stats line.
        """
        now = time.monotonic()
        if not self._receiving:
            self._receiving = True
            self._stats_since = self._connected_at = now
        self.frames_in += 1
        self._received_times.append(now)

    def take_due(self, sampler: FrameSampler, now: float) -> tuple[np.ndarray, int] | None:
        """Pop the pending frame if one is waiting and the sampler lets it through."""
        with self._lock:
            if self._pending is None or not sampler.accept(now):
                return None
            frame, pts, self._pending = self._pending, self._pending_pts, None
            return frame, pts

    def record_analysed(self, elapsed_ms: float) -> None:
        with self._lock:
            self.frames_analysed += 1
            self._analysed_times.append(time.monotonic())
            self.model_ms += elapsed_ms

    def rates(self) -> tuple[float, float]:
        """(frames received, frames analysed) per second, averaged over the last
        RATE_WINDOW_S (or since the camera connected, if that is shorter)."""
        now = time.monotonic()
        window = max(min(RATE_WINDOW_S, now - self._connected_at), 1.0)
        with self._lock:
            for times in (self._received_times, self._analysed_times):
                while times and times[0] < now - window:
                    times.popleft()
            return len(self._received_times) / window, len(self._analysed_times) / window

    def take_stats(self) -> tuple[int, int, float, float]:
        """(frames received, frames analysed, total model ms, seconds covered) since
        the last call. The first window starts when the camera connected, not at the
        previous stats line, so a camera that joins mid-window isn't reported as slow."""
        now = time.monotonic()
        with self._lock:
            stats = (self.frames_in, self.frames_analysed, self.model_ms, max(now - self._stats_since, 1e-6))
            self.frames_in = self.frames_analysed = 0
            self.model_ms = 0.0
            self._stats_since = now
        return stats