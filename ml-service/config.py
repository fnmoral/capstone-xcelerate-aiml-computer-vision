"""Loads config.yaml into typed settings.

The file has shared settings plus a `dev:` and a `prod:` section. `prod_mode` (or the
ML_PROD_MODE environment variable) picks one, and its keys override the shared ones.
"""

import os
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from fall.rules import RuleThresholds
from fall.state_machine import MonitorConfig


@dataclass(slots=True)
class InferenceConfig:
    weights: str = "yolo26n-pose.pt"
    device: str | int = "auto"
    half: bool = False            # FP16 on GPU: faster on modern NVIDIA cards, ignored on CPU
    conf: float = 0.4
    imgsz: int = 640
    target_fps: float = 10.0
    tracker: str = "bytetrack.yaml"


SOURCE_TYPES = ("tcp", "webcam", "rtsp", "file")
PROD_SOURCE_TYPES = ("tcp", "rtsp")  # production watches IP cameras only
MODE_KEYS = {"sources", "source", "preview", "server", "handshake", "inference", "output", "fall"}


@dataclass(slots=True)
class SourceConfig:
    """One video source. tcp = every camera stream-hub sends; the others are read directly."""
    type: str
    camera_id: str = ""
    index: int = 0                # webcam
    url: str = ""                 # rtsp
    path: str = ""                # file, relative to the config file
    loop: bool = True             # file: restart when it ends
    tenant_id: str = ""           # webcam/rtsp/file; empty = handshake.default_tenant_id


@dataclass(slots=True)
class Config:
    prod_mode: bool = False
    sources: list[SourceConfig] = field(default_factory=lambda: [SourceConfig("tcp")])
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

    @property
    def uses_tcp(self) -> bool:
        return any(s.type == "tcp" for s in self.sources)

    def check_mode(self) -> None:
        """Prod mode refuses anything that isn't an IP camera, so dev sources can't leak into production."""
        if not self.prod_mode:
            return
        bad = [f"{s.type} ({s.camera_id})" for s in self.sources if s.type not in PROD_SOURCE_TYPES]
        if bad:
            raise ValueError(f"prod_mode only allows IP camera sources {PROD_SOURCE_TYPES}, "
                             f"found: {', '.join(bad)}. Use prod_mode: false for prototyping.")


def parse_bool(value) -> bool:
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in ("1", "true", "yes", "on"):
        return True
    if text in ("0", "false", "no", "off", ""):
        return False
    raise ValueError(f"expected true/false, got {value!r}")


def merge(base: dict, override: dict) -> dict:
    """Recursively overlay override onto base. Lists and scalars are replaced, not merged."""
    out = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = merge(out[key], value)
        else:
            out[key] = value
    return out


def resolve_mode(raw: dict, prod_mode: bool | None) -> tuple[bool, dict]:
    """Pick the mode (argument > ML_PROD_MODE > file) and return the settings with its section applied."""
    if prod_mode is None:
        env = os.environ.get("ML_PROD_MODE")
        prod_mode = parse_bool(env) if env is not None else parse_bool(raw.get("prod_mode", False))

    name = "prod" if prod_mode else "dev"
    section = raw.get(name) or {}
    unknown = set(section) - MODE_KEYS
    if unknown:
        raise ValueError(f"unknown keys under {name}: {sorted(unknown)}")
    shared = {k: v for k, v in raw.items() if k not in ("prod_mode", "dev", "prod")}
    # A mode's source list replaces a shared one entirely, whichever key spelling either uses.
    if "sources" in section or "source" in section:
        shared.pop("sources", None)
        shared.pop("source", None)
    return prod_mode, merge(shared, section)


def parse_sources(raw_sources: list[dict], base: Path, default_tenant: str) -> list[SourceConfig]:
    sources: list[SourceConfig] = []
    for i, entry in enumerate(raw_sources):
        entry = dict(entry)
        if "webcam_index" in entry:  # older config files
            entry["index"] = entry.pop("webcam_index")
        src = SourceConfig(**entry)
        where = f"sources[{i}] ({src.type})"

        match src.type:
            case "tcp":
                pass
            case "webcam":
                src.camera_id = src.camera_id or f"webcam-{src.index}"
            case "rtsp":
                if not src.url:
                    raise ValueError(f"{where} needs a url")
                src.camera_id = src.camera_id or f"rtsp-{i}"
            case "file":
                if not src.path:
                    raise ValueError(f"{where} needs a path")
                src.path = str(base / src.path)
                src.camera_id = src.camera_id or Path(src.path).stem
            case _:
                raise ValueError(f"{where}: type must be one of {SOURCE_TYPES}")
        if src.type != "tcp":
            src.tenant_id = src.tenant_id or default_tenant
        sources.append(src)

    if sum(s.type == "tcp" for s in sources) > 1:
        raise ValueError("only one tcp source is allowed; it already receives every stream-hub camera")
    ids = [s.camera_id for s in sources if s.type != "tcp"]
    duplicates = sorted({c for c in ids if ids.count(c) > 1})
    if duplicates:
        raise ValueError(f"camera_id must be unique, repeated: {duplicates}")
    return sources


def load(path: str | Path, prod_mode: bool | None = None) -> Config:
    """Read the config file for one mode. prod_mode=None means ML_PROD_MODE, then the file's prod_mode.

    Relative paths inside the file (weights, output dir, video files) resolve against the file's folder.
    """
    path = Path(path).resolve()
    base = path.parent
    prod_mode, raw = resolve_mode(yaml.safe_load(path.read_text(encoding="utf-8")) or {}, prod_mode)
    server = raw.get("server", {})
    handshake = raw.get("handshake", {})
    fall = dict(raw.get("fall", {}))
    output = raw.get("output", {})
    default_tenant = handshake.get("default_tenant_id", "tenant_example")

    min_kpt_conf = fall.pop("min_keypoint_conf", 0.3)
    rule_keys = RuleThresholds.__dataclass_fields__.keys()
    monitor_keys = MonitorConfig.__dataclass_fields__.keys()
    unknown = set(fall) - set(rule_keys) - set(monitor_keys)
    if unknown:
        raise ValueError(f"unknown keys under fall: {sorted(unknown)}")

    inference = InferenceConfig(**raw.get("inference", {}))
    inference.weights = str(base / inference.weights)

    if "sources" in raw:
        raw_sources = raw["sources"] or []
    elif "source" in raw:  # older config files had a single source
        raw_sources = [raw["source"]]
    else:
        raw_sources = [{"type": "tcp"}]
    if not raw_sources:
        raise ValueError("sources is empty")

    cfg = Config(
        prod_mode=prod_mode,
        sources=parse_sources(raw_sources, base, default_tenant),
        show=bool(raw.get("preview", False)),
        host=server.get("host", "127.0.0.1"),
        port=int(server.get("port", 9999)),
        tenant_in_handshake=bool(handshake.get("tenant_in_handshake", False)),
        default_tenant_id=default_tenant,
        inference=inference,
        rules=RuleThresholds(**{k: v for k, v in fall.items() if k in rule_keys}),
        rules_min_kpt_conf=float(min_kpt_conf),
        monitor=MonitorConfig(**{k: v for k, v in fall.items() if k in monitor_keys}),
        output_dir=str(base / output.get("dir", "data")),
        prediction_interval_s=float(output.get("prediction_interval_s", 1.0)),
    )
    cfg.check_mode()
    return cfg
