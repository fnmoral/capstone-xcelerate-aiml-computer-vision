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


@dataclass(slots=True)
class Config:
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
    raw = yaml.safe_load(Path(path).read_text(encoding="utf-8")) or {}
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

    return Config(
        host=server.get("host", "127.0.0.1"),
        port=int(server.get("port", 9999)),
        tenant_in_handshake=bool(handshake.get("tenant_in_handshake", False)),
        default_tenant_id=handshake.get("default_tenant_id", "tenant_example"),
        inference=InferenceConfig(**raw.get("inference", {})),
        rules=RuleThresholds(**{k: v for k, v in fall.items() if k in rule_keys}),
        rules_min_kpt_conf=float(min_kpt_conf),
        monitor=MonitorConfig(**{k: v for k, v in fall.items() if k in monitor_keys}),
        output_dir=output.get("dir", "data"),
        prediction_interval_s=float(output.get("prediction_interval_s", 1.0)),
    )
