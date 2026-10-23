"""Writes results to the backend-module PostgreSQL database (backend-module/db/schema.sql).

All database work happens on one background thread, so a slow or unreachable database
never stalls video analysis. If the database is down, records wait in memory and are
retried every few seconds; when the queue is full, predictions are dropped first and
incidents are always kept.

ID mapping (the schema stores UUIDs):
- tenant: a UUID as-is, otherwise looked up by tenants.slug (e.g. 'demo-facility')
- camera: a UUID as-is (gateway-back camera IDs), otherwise looked up by cameras.name for
  the tenant (e.g. 'CAM-02 Living Room'), otherwise a stable UUID derived from the name
  (uuid5), so 'local-webcam' always maps to the same ID

Tables written: incidents, incident_cameras, alerts (one per incident), model_predictions.
Every write sets app.tenant_id for its transaction, so row-level security applies.
"""

import logging
import queue
import threading
import time
import uuid
from datetime import UTC, datetime

import psycopg
from psycopg.types.json import Jsonb

log = logging.getLogger(__name__)

# Namespace for deterministic IDs of cameras that aren't UUIDs and aren't in the cameras table.
CAMERA_NAMESPACE = uuid.UUID("6b9f6b1e-2d1c-4a8e-9d3e-7f2a51c0e001")
ALERT_NAMESPACE = uuid.UUID("6b9f6b1e-2d1c-4a8e-9d3e-7f2a51c0e002")
RETRY_SECONDS = 5.0
BATCH_SIZE = 200
CAMERA_CACHE_SECONDS = 60.0  # cameras get registered/renamed in the frontend while running


class UnknownTenant(Exception):
    pass


def as_uuid(value: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(value))
    except ValueError:
        return None


def derived_camera_id(tenant_id: uuid.UUID, camera: str) -> uuid.UUID:
    return uuid.uuid5(CAMERA_NAMESPACE, f"{tenant_id}/{camera}")


def alert_id_for(incident_id: str) -> uuid.UUID:
    return uuid.uuid5(ALERT_NAMESPACE, str(incident_id))


class Resolver:
    """Maps service-side tenant/camera names to database UUIDs, with caching."""

    def __init__(self):
        self._tenants: dict[str, uuid.UUID] = {}
        self._cameras: dict[tuple[uuid.UUID, str], tuple[float, tuple[uuid.UUID, str | None]]] = {}
        self._rules: dict[uuid.UUID, uuid.UUID | None] = {}
        self._warned: set[str] = set()

    def tenant(self, cur, tenant: str) -> uuid.UUID:
        if (cached := self._tenants.get(tenant)) is not None:
            return cached
        tid = as_uuid(tenant)
        if tid is None:
            row = cur.execute("SELECT id FROM tenants WHERE slug = %s", (tenant,)).fetchone()
            if row is None:
                raise UnknownTenant(tenant)
            tid = row[0]
        self._tenants[tenant] = tid
        return tid

    def camera(self, cur, tenant_id: uuid.UUID, camera: str) -> tuple[uuid.UUID, str | None]:
        """(camera UUID, where to say a fall happened: cameras.location, or the camera's name
        when it has no location; None if the camera isn't in the database). Needs
        app.tenant_id set for RLS."""
        key = (tenant_id, camera)
        if (cached := self._cameras.get(key)) is not None and time.monotonic() < cached[0]:
            return cached[1]
        cid = as_uuid(camera)
        if cid is not None:
            row = cur.execute("SELECT coalesce(nullif(trim(location), ''), name) FROM cameras WHERE id = %s",
                              (cid,)).fetchone()
            result = (cid, row[0] if row else None)
        else:
            row = cur.execute("SELECT id, coalesce(nullif(trim(location), ''), name) FROM cameras "
                              "WHERE tenant_id = %s AND name = %s",
                              (tenant_id, camera)).fetchone()
            result = (row[0], row[1]) if row else (derived_camera_id(tenant_id, camera), None)
        self._cameras[key] = (time.monotonic() + CAMERA_CACHE_SECONDS, result)
        return result

    def fall_rule(self, cur, tenant_id: uuid.UUID) -> uuid.UUID | None:
        if tenant_id not in self._rules:
            row = cur.execute(
                "SELECT id FROM rules WHERE tenant_id = %s AND is_enabled "
                "AND parsed_config->>'event_type' = 'fall' ORDER BY created_at LIMIT 1",
                (tenant_id,)).fetchone()
            self._rules[tenant_id] = row[0] if row else None
        return self._rules[tenant_id]

    def warn_once(self, key: str, message: str, *args) -> None:
        if key not in self._warned:
            self._warned.add(key)
            log.warning(message, *args)


def summary(rec: dict, location: str | None) -> str:
    where = location or rec.get("zone") or f"camera {rec['camera_id']}"
    text = f"Fall detected in {where}."
    if len(rec["camera_ids"]) > 1:
        text += f" Seen by {len(rec['camera_ids'])} cameras."
    if rec["status"] == "recovered" and rec["recovered_at"] and rec["started_at"]:
        text += f" Person recovered after {int((rec['recovered_at'] - rec['started_at']).total_seconds())} seconds."
    elif rec["status"] == "unresolved":
        text += " Person went out of view while still down; check on them."
    elif rec["severity"] in ("high", "critical"):
        text += " Person has not recovered."
    return text


class PostgresSink:
    def __init__(self, url: str, connect_timeout_s: float = 5.0, max_queued_predictions: int = 20000):
        self.url = url
        self.connect_timeout_s = connect_timeout_s
        self.max_queued_predictions = max_queued_predictions
        self.resolver = Resolver()
        self._queue: queue.Queue = queue.Queue()
        self._queued_predictions = 0
        self._dropped_predictions = 0
        self._count_lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="postgres-sink", daemon=True)
        self._thread.start()

    # ---------- called from pipeline threads ----------

    def prediction(self, record: dict) -> None:
        with self._count_lock:
            if self._queued_predictions >= self.max_queued_predictions:
                self._dropped_predictions += 1
                if self._dropped_predictions % 1000 == 1:
                    log.warning("database is behind: dropped %d prediction rows so far", self._dropped_predictions)
                return
            self._queued_predictions += 1
        self._queue.put(("prediction", record))

    def incident(self, record: dict) -> None:
        self._queue.put(("incident", record))

    def clip(self, record: dict) -> None:
        self._queue.put(("clip", record))

    def flush(self, timeout: float = 10.0) -> bool:
        """Wait until everything queued so far is written. False if it timed out."""
        deadline = time.monotonic() + timeout
        while self._queue.unfinished_tasks:
            if time.monotonic() > deadline:
                return False
            time.sleep(0.02)
        return True

    def close(self, timeout: float = 5.0) -> None:
        if not self.flush(timeout):
            log.warning("database: %d records not written at shutdown", self._queue.unfinished_tasks)
        self._stop.set()
        self._thread.join(timeout=2)

    # ---------- zones from the database (called once at startup) ----------

    def load_zones(self) -> dict[str, list[str]]:
        """Zone name -> cameras, from zones + cameras.zone_id, across all tenants.

        Each camera is listed by UUID (how stream-hub cameras arrive) and by cameras.name
        (how a dev source can refer to it), so either form matches.
        """
        zones: dict[str, list[str]] = {}
        with psycopg.connect(self.url, connect_timeout=self.connect_timeout_s, autocommit=True) as conn:
            tenants = [r[0] for r in conn.execute("SELECT id FROM tenants WHERE status = 'active'")]
            for tid in tenants:
                with conn.transaction():
                    conn.execute("SELECT set_config('app.tenant_id', %s, true)", (str(tid),))
                    rows = conn.execute(
                        "SELECT z.name, c.id, c.name FROM cameras c JOIN zones z ON z.id = c.zone_id "
                        "WHERE c.tenant_id = %s ORDER BY z.name, c.name", (tid,)).fetchall()
                for zone, cam_id, cam_name in rows:
                    zones.setdefault(zone, []).extend([str(cam_id), cam_name])
        return zones

    def load_overrides(self) -> dict[str, dict]:
        """Detection settings changed in the frontend, per tenant (keyed by slug and by UUID):
        the fall rule's parsed_config.detection, e.g. {"person_confidence": 0.6}."""
        out: dict[str, dict] = {}
        with psycopg.connect(self.url, connect_timeout=self.connect_timeout_s, autocommit=True) as conn:
            tenants = conn.execute("SELECT id, slug FROM tenants WHERE status = 'active'").fetchall()
            for tid, slug in tenants:
                with conn.transaction():
                    conn.execute("SELECT set_config('app.tenant_id', %s, true)", (str(tid),))
                    row = conn.execute(
                        "SELECT parsed_config->'detection' FROM rules WHERE tenant_id = %s AND is_enabled "
                        "AND parsed_config->>'event_type' = 'fall' ORDER BY created_at LIMIT 1", (tid,)).fetchone()
                settings = row[0] if row and isinstance(row[0], dict) else {}
                out[str(tid)] = out[slug] = settings
        return out

    # ---------- background writer ----------

    def _run(self) -> None:
        conn = None
        while not (self._stop.is_set() and self._queue.empty()):
            batch = self._take_batch()
            if not batch:
                continue
            while True:
                try:
                    if conn is None or conn.closed:
                        conn = self._connect()
                    self._write(conn, batch)
                    break
                except psycopg.OperationalError as e:
                    log.warning("database unavailable (%s); retrying in %.0fs", str(e).strip().splitlines()[0],
                                RETRY_SECONDS)
                    if conn is not None:
                        conn.close()
                    conn = None
                    if self._stop.wait(RETRY_SECONDS):
                        log.error("database: dropping %d records at shutdown", len(batch))
                        break
                except Exception:
                    log.exception("database write failed; dropping %d records", len(batch))
                    if conn is not None and not conn.closed:
                        conn.rollback()
                    break
            for kind, _ in batch:
                if kind == "prediction":
                    with self._count_lock:
                        self._queued_predictions -= 1
                self._queue.task_done()
        if conn is not None:
            conn.close()

    def _take_batch(self) -> list[tuple[str, dict]]:
        try:
            batch = [self._queue.get(timeout=0.5)]
        except queue.Empty:
            return []
        while len(batch) < BATCH_SIZE:
            try:
                batch.append(self._queue.get_nowait())
            except queue.Empty:
                break
        return batch

    def _connect(self):
        conn = psycopg.connect(self.url, connect_timeout=self.connect_timeout_s)
        log.info("database connected")
        try:
            with conn.transaction():
                conn.execute("SELECT create_monthly_partitions(date_trunc('month', now())::date, 2)")
        except psycopg.errors.UndefinedFunction:
            log.warning("create_monthly_partitions() is missing; update backend-module/db/schema.sql")
        except psycopg.errors.InsufficientPrivilege:
            # Normal for a restricted role: only the table owner can add partitions. Rows still
            # go to the DEFAULT partition, but a monthly admin job should create them ahead.
            log.info("this database role can't create monthly partitions (needs the table owner); "
                     "run create_monthly_partitions() from a monthly admin job")
        except psycopg.Error as e:
            log.warning("could not create monthly partitions: %s", str(e).strip().splitlines()[0])
        return conn

    def _write(self, conn, batch: list[tuple[str, dict]]) -> None:
        with conn.transaction(), conn.cursor() as cur:
            for kind, rec in batch:
                try:
                    tenant = self.resolver.tenant(cur, rec["tenant_id"])
                except UnknownTenant:
                    self.resolver.warn_once(f"tenant:{rec['tenant_id']}",
                                            "tenant %r is not in the tenants table; its records are not stored "
                                            "(set handshake.default_tenant_id to a tenant slug or UUID)",
                                            rec["tenant_id"])
                    continue
                cur.execute("SELECT set_config('app.tenant_id', %s, true)", (str(tenant),))
                if kind == "prediction":
                    self._write_prediction(cur, tenant, rec)
                elif kind == "clip":
                    self._write_clip(cur, tenant, rec)
                else:
                    self._write_incident(cur, tenant, rec)

    def _write_prediction(self, cur, tenant: uuid.UUID, rec: dict) -> None:
        camera, _ = self.resolver.camera(cur, tenant, rec["camera_id"])
        cur.execute(
            "INSERT INTO model_predictions (tenant_id, camera_id, incident_id, predicted_at, model_name, "
            "model_version, label, confidence, output, inference_ms) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
            (tenant, camera, rec["incident_id"], rec["predicted_at"], rec["model_name"], rec["model_version"],
             rec["label"], rec["confidence"], Jsonb(rec["output"]), rec["inference_ms"]))

    def _write_clip(self, cur, tenant: uuid.UUID, rec: dict) -> None:
        camera, _ = self.resolver.camera(cur, tenant, rec["camera_id"])
        cur.execute("SAVEPOINT clip")
        try:
            cur.execute("UPDATE incident_cameras SET clip_key = %s WHERE incident_id = %s AND camera_id = %s",
                        (rec["clip_key"], rec["incident_id"], camera))
        except psycopg.errors.UndefinedColumn:
            cur.execute("ROLLBACK TO SAVEPOINT clip")
            self.resolver.warn_once("clip_key", "incident_cameras.clip_key is missing: start the backend API "
                                    "(it adds the column) or update the schema; clips are saved but not linked")
        # The incident's main clip: its first camera's, else the first one saved.
        cur.execute("UPDATE incidents SET clip_key = CASE WHEN camera_id = %s OR clip_key IS NULL "
                    "THEN %s ELSE clip_key END WHERE id = %s",
                    (camera, rec["clip_key"], rec["incident_id"]))

    def _write_incident(self, cur, tenant: uuid.UUID, rec: dict) -> None:
        camera, location = self.resolver.camera(cur, tenant, rec["camera_id"])
        incident_id = rec["id"]

        # Update first: a joining camera can move started_at earlier, so match on id alone.
        cur.execute(
            "UPDATE incidents SET camera_id = %s, zone = %s, started_at = %s, recovered_at = %s, status = %s, "
            "severity = %s, peak_confidence = %s, snapshot_key = COALESCE(snapshot_key, %s) WHERE id = %s",
            (camera, rec["zone"], rec["started_at"], rec["recovered_at"], rec["status"], rec["severity"],
             rec["peak_confidence"], rec["snapshot_key"], incident_id))
        if cur.rowcount == 0:
            cur.execute(
                "INSERT INTO incidents (id, tenant_id, camera_id, zone, incident_type, started_at, recovered_at, "
                "status, severity, peak_confidence, location_label, snapshot_key) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                (incident_id, tenant, camera, rec["zone"], rec["incident_type"], rec["started_at"],
                 rec["recovered_at"], rec["status"], rec["severity"], rec["peak_confidence"], location,
                 rec["snapshot_key"]))

        for track in rec["tracks"]:
            cam_name, _, track_id = track.rpartition("#")
            cam_id, _ = self.resolver.camera(cur, tenant, cam_name)
            cur.execute(
                "INSERT INTO incident_cameras (tenant_id, incident_id, camera_id, track_id, joined_at) "
                "VALUES (%s, %s, %s, %s, %s) ON CONFLICT DO NOTHING",
                (tenant, incident_id, cam_id, int(track_id), rec["event_at"]))
        if rec["snapshot_key"] and rec["snapshot_camera"]:
            snap_cam, _ = self.resolver.camera(cur, tenant, rec["snapshot_camera"])
            cur.execute(
                "UPDATE incident_cameras SET snapshot_key = %s "
                "WHERE incident_id = %s AND camera_id = %s AND snapshot_key IS NULL",
                (rec["snapshot_key"], incident_id, snap_cam))

        text = summary(rec, location)
        if rec["event"] == "incident_started":
            cur.execute(
                "INSERT INTO alerts (id, tenant_id, rule_id, camera_id, incident_id, triggered_at, severity, "
                "status, summary, snapshot_key) VALUES (%s, %s, %s, %s, %s, %s, %s, 'open', %s, %s)",
                (alert_id_for(incident_id), tenant, self.resolver.fall_rule(cur, tenant), camera, incident_id,
                 rec["event_at"] or datetime.now(UTC), rec["severity"], text, rec["snapshot_key"]))
        else:
            # The alert's status belongs to the people handling it; only keep its facts current.
            cur.execute("UPDATE alerts SET severity = %s, summary = %s WHERE incident_id = %s",
                        (rec["severity"], text, incident_id))
