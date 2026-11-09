"""Database-backed configuration: output sinks, zones and the detection-setting
overrides the frontend can change, kept in sync without a restart.
"""

import logging
import threading

import config
from app.runtime import Runtime
from sinks import FanoutSink
from sinks.jsonl import JsonlSink

log = logging.getLogger("ml-service")


def build_sink(cfg: config.Config) -> tuple[FanoutSink, object | None]:
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


def load_overrides(pg, runtime: Runtime) -> None:
    try:
        new = pg.load_overrides()
    except Exception as e:
        log.warning("could not load detection settings from the database (%s)", str(e).strip().splitlines()[0])
        return
    if new != runtime.overrides:
        changed = {k: v for k, v in new.items() if v and runtime.overrides.get(k) != v}
        runtime.overrides = new
        for tenant, settings in changed.items():
            log.info("detection settings for tenant [%s] changed in the frontend: %s", tenant, settings)


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


def refresh_from_db(cfg: config.Config, pg, runtime: Runtime, stop: threading.Event,
                    every_s: float = 15.0) -> None:
    """Zones (Cameras page) and detection settings (Detection Settings page) are edited in
    the frontend; pick up changes without a restart."""
    current = None
    while not stop.wait(every_s):
        load_overrides(pg, runtime)
        if not cfg.zones_from_db:
            continue
        db_zones = load_db_zones(pg)
        if db_zones is None:
            continue
        zones = merge_zones(cfg.zones, db_zones)
        if zones != current:
            current = zones
            runtime.aggregator.set_zones(zones)
            log.info("zones reloaded from the database: %s", ", ".join(zones) or "none")