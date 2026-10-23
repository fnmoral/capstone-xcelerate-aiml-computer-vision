"""H.264 decoding and frame-rate sampling for one camera."""

import logging

import av
import numpy as np

from ingest.protocol import to_annexb

log = logging.getLogger(__name__)


class H264Decoder:
    """Decodes a stream of NALUs into BGR frames. One instance per camera."""

    def __init__(self, camera_id: str):
        self.camera_id = camera_id
        self._codec = av.CodecContext.create("h264", "r")
        self._errors = 0

    def decode(self, nalu: bytes) -> list[np.ndarray]:
        frames: list[np.ndarray] = []
        try:
            for packet in self._codec.parse(to_annexb(nalu)):
                for frame in self._codec.decode(packet):
                    frames.append(frame.to_ndarray(format="bgr24"))
        except av.FFmpegError as e:
            # Expected until the first keyframe arrives, or after the hub drops NALUs.
            self._errors += 1
            if self._errors % 100 == 1:
                log.warning("[%s] decode error #%d: %s", self.camera_id, self._errors, e)
        return frames


class FrameSampler:
    """Lets through at most target_fps frames per second, so inference keeps up with the stream."""

    def __init__(self, target_fps: float):
        self._interval = 1.0 / target_fps if target_fps > 0 else 0.0
        self._next = 0.0

    def accept(self, now: float) -> bool:
        if now < self._next:
            return False
        self._next = now + self._interval
        return True
