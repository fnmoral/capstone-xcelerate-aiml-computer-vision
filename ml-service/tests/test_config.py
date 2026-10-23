from pathlib import Path

import pytest

import config

ROOT = Path(__file__).resolve().parents[1]


def write(tmp_path, text):
    p = tmp_path / "config.yaml"
    p.write_text(text, encoding="utf-8")
    return config.load(p)


def test_sources_list_mixed(tmp_path):
    cfg = write(tmp_path, """
sources:
  - type: tcp
  - type: webcam
    index: 1
  - type: rtsp
    url: rtsp://u:p@cam/1
    camera_id: hall
  - type: file
    path: clips/fall.mp4
handshake:
  default_tenant_id: t1
""")
    tcp, cam, rtsp, file = cfg.sources
    assert cfg.uses_tcp and tcp.type == "tcp"
    assert (cam.camera_id, cam.index, cam.tenant_id) == ("webcam-1", 1, "t1")
    assert rtsp.camera_id == "hall"
    assert file.camera_id == "fall" and Path(file.path) == tmp_path / "clips" / "fall.mp4"


def test_no_sources_means_tcp(tmp_path):
    cfg = write(tmp_path, "preview: false\n")
    assert [s.type for s in cfg.sources] == ["tcp"]


def test_legacy_single_source(tmp_path):
    cfg = write(tmp_path, "source:\n  type: webcam\n  webcam_index: 2\n  camera_id: old\n")
    assert len(cfg.sources) == 1
    assert (cfg.sources[0].index, cfg.sources[0].camera_id) == (2, "old")
    assert not cfg.uses_tcp


@pytest.mark.parametrize("text, message", [
    ("sources:\n  - type: rtsp\n", "needs a url"),
    ("sources:\n  - type: file\n", "needs a path"),
    ("sources:\n  - type: usb\n", "type must be one of"),
    ("sources:\n  - type: tcp\n  - type: tcp\n", "only one tcp"),
    ("sources:\n  - type: webcam\n  - type: webcam\n", "must be unique"),
    ("sources: []\n", "empty"),
])
def test_invalid_sources(tmp_path, text, message):
    with pytest.raises(ValueError, match=message):
        write(tmp_path, text)


MODES = """
prod_mode: {prod}
dev:
  sources:
    - type: webcam
  preview: true
  server: {{host: 127.0.0.1}}
prod:
  sources:
    - type: tcp
    - type: rtsp
      url: rtsp://cam/1
  preview: false
  server: {{host: 0.0.0.0}}
  inference: {{weights: big.pt}}
server: {{port: 9999}}
inference: {{weights: small.pt, conf: 0.5}}
"""


@pytest.fixture(autouse=True)
def no_env_mode(monkeypatch):
    monkeypatch.delenv("ML_PROD_MODE", raising=False)


def test_dev_mode_uses_dev_section(tmp_path):
    cfg = write(tmp_path, MODES.format(prod="false"))
    assert not cfg.prod_mode
    assert [s.type for s in cfg.sources] == ["webcam"]
    assert cfg.show and cfg.host == "127.0.0.1" and cfg.port == 9999
    assert cfg.inference.weights.endswith("small.pt")


def test_prod_mode_uses_prod_section_over_shared(tmp_path):
    cfg = write(tmp_path, MODES.format(prod="true"))
    assert cfg.prod_mode
    assert [s.type for s in cfg.sources] == ["tcp", "rtsp"]
    assert not cfg.show and cfg.host == "0.0.0.0" and cfg.port == 9999
    assert cfg.inference.weights.endswith("big.pt")  # overridden by prod:
    assert cfg.inference.conf == 0.5                  # still shared


@pytest.mark.parametrize("env, expected", [("true", True), ("1", True), ("no", False), ("FALSE", False)])
def test_env_var_overrides_file(tmp_path, monkeypatch, env, expected):
    monkeypatch.setenv("ML_PROD_MODE", env)
    assert write(tmp_path, MODES.format(prod="no" if expected else "yes")).prod_mode is expected


def test_argument_overrides_env_and_file(tmp_path, monkeypatch):
    monkeypatch.setenv("ML_PROD_MODE", "true")
    p = tmp_path / "config.yaml"
    p.write_text(MODES.format(prod="true"), encoding="utf-8")
    assert config.load(p, prod_mode=False).prod_mode is False


def test_prod_rejects_non_ip_sources(tmp_path):
    text = MODES.format(prod="true").replace("    - type: tcp\n", "    - type: tcp\n    - type: webcam\n", 1)
    text = text.replace("  sources:\n    - type: webcam\n  preview: true", "  preview: true", 1)
    with pytest.raises(ValueError, match="only allows IP camera"):
        write(tmp_path, text)


def test_prod_check_applies_to_cli_sources(tmp_path):
    cfg = write(tmp_path, MODES.format(prod="true"))
    cfg.sources = config.parse_sources([{"type": "file", "path": "x.mp4"}], tmp_path, "t")
    with pytest.raises(ValueError, match="only allows IP camera"):
        cfg.check_mode()


def test_unknown_key_in_mode_section(tmp_path):
    with pytest.raises(ValueError, match="unknown keys under dev"):
        write(tmp_path, "dev:\n  sourcez: []\n")


def test_shipped_config_both_modes():
    dev = config.load(ROOT / "config.yaml", prod_mode=False)
    assert not dev.prod_mode and dev.sources and dev.host == "127.0.0.1"

    prod = config.load(ROOT / "config.yaml", prod_mode=True)
    assert prod.prod_mode and not prod.show and prod.host == "0.0.0.0"
    assert all(s.type in config.PROD_SOURCE_TYPES for s in prod.sources)
    assert prod.inference.weights == dev.inference.weights
