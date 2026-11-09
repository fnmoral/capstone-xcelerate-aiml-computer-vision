"""Command-line parsing: turns config.yaml, CLI flags and environment variables
into the final Config (see main.py's module docstring for the user-facing --help).
"""

import argparse
import os
from pathlib import Path

import config as config_module

DEFAULT_CONFIG_ENV = "ML_CONFIG"


def build_parser() -> argparse.ArgumentParser:
    default_config = os.environ.get(DEFAULT_CONFIG_ENV) or str(
        Path(__file__).resolve().parents[1] / "config.yaml")
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
    return parser


def build_config(argv: list[str] | None = None) -> config_module.Config:
    """Parses argv and returns the final Config. Raises ValueError on a bad config
    or an invalid combination of flags (e.g. --prod with --webcam).
    """
    args = build_parser().parse_args(argv)

    cfg = config_module.load(args.config, args.prod_mode)
    cli_sources = ([{"type": "webcam", "index": i} for i in args.webcam or []]
                   + [{"type": "rtsp", "url": u} for u in args.rtsp or []]
                   + [{"type": "file", "path": str(Path(p).resolve())} for p in args.video or []]
                   + ([{"type": "tcp"}] if args.tcp else []))
    if cli_sources:
        cfg.sources = config_module.parse_sources(cli_sources, Path.cwd(), cfg.default_tenant_id)
        cfg.check_mode()
    if args.show is not None:
        cfg.show = args.show
    return cfg