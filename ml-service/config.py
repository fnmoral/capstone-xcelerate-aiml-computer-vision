"""Loads config.yaml into typed settings."""

from dataclasses import dataclass, field
from pathlib import Path

import yaml

from fall.rules import RuleThresholds
from fall.state_machine import MonitorConfig


@dataclass(slots=True)
class InferenceConfig:
    weights: str = "yolo26n-pose.pt"
    device: str | int = 0
    conf: float = 0.4
    imgsz: int = 640
    target_fps: float = 10.0
    tracker: str = "bytetrack.yaml"


SOURCE_TYPES = ("tcp", "webcam", "file")


@dataclass(slots=True)
class SourceConfig:
    type: str = "tcp"             # tcp = streams from stream-hub; webcam/file = read locally
    webcam_index: int = 0
    path: str = ""
    camera_id: str = "local-webcam"
    loop: bool = True             # restart a video file when it ends


@dataclass(slots=True)
class Config:
    source: SourceConfig = field(default_factory=SourceConfig)
    host: str = "127.0.0.1"
    port: int = 9999
    tenant_in_handshake: bool = False
    default_tenant_id: str = "tenant_example"
    inference: InferenceConfig = field(default_factory=InferenceConfig)
    rules: RuleThresholds = field(default_factory=RuleThresholds)
    rules_min_kpt_conf: float = 0.3
    monitor: MonitorConfig = field(default_factory=MonitorConfig)
    output_dir: str = "data"
    prediction_interval_s: float = 1.0
    show: bool = False


def load(path: str | Path) -> Config:
    """Relative paths inside the file (weights, output dir) resolve against the file's folder."""
    path = Path(path).resolve()
    base = path.parent
    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    server = raw.get("server", {})
    handshake = raw.get("handshake", {})
    fall = dict(raw.get("fall", {}))
    output = raw.get("output", {})

    min_kpt_conf = fall.pop("min_keypoint_conf", 0.3)
    rule_keys = RuleThresholds.__dataclass_fields__.keys()
    monitor_keys = MonitorConfig.__dataclass_fields__.keys()
    unknown = set(fall) - set(rule_keys) - set(monitor_keys)
    if unknown:
        raise ValueError(f"unknown keys under fall: {sorted(unknown)}")

    inference = InferenceConfig(**raw.get("inference", {}))
    inference.weights = str(base / inference.weights)

    source = SourceConfig(**raw.get("source", {}))
    if source.type not in SOURCE_TYPES:
        raise ValueError(f"source.type must be one of {SOURCE_TYPES}, got {source.type!r}")
    if source.path:
        source.path = str(base / source.path)

    return Config(
        source=source,
        show=bool(raw.get("preview", False)),
        host=server.get("host", "127.0.0.1"),
        port=int(server.get("port", 9999)),
        tenant_in_handshake=bool(handshake.get("tenant_in_handshake", False)),
        default_tenant_id=handshake.get("default_tenant_id", "tenant_example"),
        inference=inference,
        rules=RuleThresholds(**{k: v for k, v in fall.items() if k in rule_keys}),
        rules_min_kpt_conf=float(min_kpt_conf),
        monitor=MonitorConfig(**{k: v for k, v in fall.items() if k in monitor_keys}),
        output_dir=str(base / output.get("dir", "data")),
        prediction_interval_s=float(output.get("prediction_interval_s", 1.0)),
    )
