"""Live viewer: each camera's annotated video and the recent incidents, in a browser.

    http://localhost:8000              the page
    /stream/<camera>                   MJPEG video with boxes and labels
    /frame/<camera>.jpg                one still frame
    /api/state                         cameras, people and incidents as JSON
    /api/config                        the detection settings in use (read-only)
    /snapshots/<file>.jpg              incident photos

Runs on its own threads and never touches PyTorch: it only JPEG-encodes frames the main
thread has already annotated, and reads incident records kept in memory by ViewerSink.
There is no login, so keep the port on localhost or the internal network.
"""

import json
import logging
import re
import threading
import time
from collections import OrderedDict
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote

import cv2

log = logging.getLogger(__name__)

SNAPSHOT_NAME = re.compile(r"^[\w.-]+\.jpg$")


def _jsonable(value):
    if isinstance(value, datetime):
        return value.isoformat()
    raise TypeError(type(value).__name__)


class ViewerSink:
    """Keeps the latest state of recent incidents in memory for the viewer page."""

    def __init__(self, max_incidents: int = 50):
        self.max_incidents = max_incidents
        self._lock = threading.Lock()
        self._incidents: OrderedDict[str, dict] = OrderedDict()

    def prediction(self, record: dict) -> None:
        pass  # live labels come straight from the pipelines

    def incident(self, record: dict) -> None:
        with self._lock:
            current = self._incidents.pop(record["id"], {"snapshots": []})
            snapshots = current["snapshots"]
            if record.get("snapshot_key"):
                snapshots.append(Path(record["snapshot_key"]).name)
            self._incidents[record["id"]] = {**record, "snapshots": snapshots}
            while len(self._incidents) > self.max_incidents:
                self._incidents.popitem(last=False)

    def close(self) -> None:
        pass

    def recent(self) -> list[dict]:
        with self._lock:
            return [dict(r) for r in reversed(self._incidents.values())]


class Viewer:
    def __init__(self, host: str, port: int, fps: float, jpeg_quality: int, get_pipelines,
                 sink: ViewerSink, snapshot_dir: str, settings=None):
        self.host, self.port = host, port
        self.settings = settings or dict    # () -> read-only summary of the detection settings
        self.frame_interval = 1.0 / max(fps, 0.5)
        self.jpeg_quality = int(jpeg_quality)
        self.get_pipelines = get_pipelines   # () -> {camera_id: CameraPipeline}
        self.sink = sink
        self.snapshot_dir = Path(snapshot_dir)

    def start(self) -> None:
        viewer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, fmt, *args):  # quiet: no line per request
                pass

            def do_GET(self):
                try:
                    viewer.route(self)
                except (BrokenPipeError, ConnectionResetError):
                    pass

        server = ThreadingHTTPServer((self.host, self.port), Handler)
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, name="viewer", daemon=True).start()
        log.info("viewer at http://%s:%d", "localhost" if self.host in ("0.0.0.0", "127.0.0.1") else self.host,
                 self.port)

    # ---------- routing ----------

    def route(self, req: BaseHTTPRequestHandler) -> None:
        path = req.path.split("?", 1)[0]
        if path == "/":
            self._send(req, 200, "text/html; charset=utf-8", PAGE.encode())
        elif path == "/api/state":
            body = json.dumps(self.state(), default=_jsonable).encode()
            self._send(req, 200, "application/json", body, cache=False)
        elif path == "/api/config":
            self._send(req, 200, "application/json", json.dumps(self.settings()).encode(), cache=False)
        elif path.startswith("/stream/"):
            self.stream(req, unquote(path[len("/stream/"):]))
        elif path.startswith("/frame/") and path.endswith(".jpg"):
            jpeg = self._jpeg(unquote(path[len("/frame/"):-4]))
            if jpeg is None:
                self._send(req, 404, "text/plain", b"no frame yet")
            else:
                self._send(req, 200, "image/jpeg", jpeg, cache=False)
        elif path.startswith("/snapshots/"):
            name = unquote(path[len("/snapshots/"):])
            file = self.snapshot_dir / "snapshots" / name
            if SNAPSHOT_NAME.match(name) and file.is_file():
                self._send(req, 200, "image/jpeg", file.read_bytes())
            else:
                self._send(req, 404, "text/plain", b"not found")
        else:
            self._send(req, 404, "text/plain", b"not found")

    @staticmethod
    def _send(req, status: int, ctype: str, body: bytes, cache: bool = True) -> None:
        req.send_response(status)
        req.send_header("Content-Type", ctype)
        req.send_header("Content-Length", str(len(body)))
        if not cache:
            req.send_header("Cache-Control", "no-store")
        req.end_headers()
        req.wfile.write(body)

    # ---------- data ----------

    def state(self) -> dict:
        now = time.time()
        cameras = []
        for cam_id, p in sorted(self.get_pipelines().items()):
            cameras.append({
                "id": cam_id,
                "people": p.latest_people,
                "last_frame_age_s": round(now - p.latest_at, 1) if p.latest_at else None,
            })
        return {"cameras": cameras, "incidents": self.sink.recent()}

    def _jpeg(self, cam_id: str) -> bytes | None:
        p = self.get_pipelines().get(cam_id)
        frame = p.latest_annotated if p is not None else None
        if frame is None:
            return None
        ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, self.jpeg_quality])
        return buf.tobytes() if ok else None

    def stream(self, req: BaseHTTPRequestHandler, cam_id: str) -> None:
        req.send_response(200)
        req.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
        req.send_header("Cache-Control", "no-store")
        req.end_headers()
        last_frame = None
        gone_since = None
        while True:
            p = self.get_pipelines().get(cam_id)
            frame = p.latest_annotated if p is not None else None
            if frame is None:
                gone_since = gone_since or time.monotonic()
                if time.monotonic() - gone_since > 10:
                    return  # camera disconnected; the page reconnects when it's back
            else:
                gone_since = None
                if frame is not last_frame:
                    last_frame = frame
                    ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, self.jpeg_quality])
                    if ok:
                        data = buf.tobytes()
                        req.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: "
                                        + str(len(data)).encode() + b"\r\n\r\n" + data + b"\r\n")
                        req.wfile.flush()
            time.sleep(self.frame_interval)


PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fall Detection Viewer</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --text:#1d2330; --muted:#667085; --line:#e4e7ec;
          --ok:#12805c; --warn:#b54708; --bad:#c01048; --chip:#eef1f5; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#111418; --card:#1a1f26; --text:#e6e9ee; --muted:#98a2b3; --line:#2b323c;
            --ok:#3ccb8f; --warn:#f5a524; --bad:#f45b7a; --chip:#262d37; } }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.4 system-ui, -apple-system, Segoe UI, sans-serif; background:var(--bg); color:var(--text); }
  header { padding:14px 20px; border-bottom:1px solid var(--line); display:flex; gap:12px; align-items:baseline; flex-wrap:wrap; }
  header h1 { font-size:16px; margin:0; } header span { color:var(--muted); font-size:12px; }
  main { padding:16px 20px; display:grid; gap:20px; }
  .grid { display:grid; gap:16px; grid-template-columns:repeat(auto-fill, minmax(380px, 1fr)); }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; overflow:hidden; }
  .card img { width:100%; display:block; background:#000; aspect-ratio:16/9; object-fit:contain; }
  .meta { padding:10px 12px; display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
  .cam { font:12px ui-monospace, monospace; color:var(--muted); width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .chip { background:var(--chip); border-radius:999px; padding:2px 9px; font-size:12px; }
  .upright { color:var(--ok); } .falling { color:var(--warn); } .lying { color:var(--bad); font-weight:600; }
  .empty { color:var(--muted); padding:30px; text-align:center; }
  h2 { font-size:14px; margin:0 0 8px; }
  table { width:100%; border-collapse:collapse; background:var(--card); border:1px solid var(--line); border-radius:12px; overflow:hidden; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); font-size:13px; vertical-align:top; }
  th { color:var(--muted); font-weight:600; font-size:12px; }
  .st-active { color:var(--bad); font-weight:600; } .st-recovered { color:var(--ok); } .st-unresolved { color:var(--warn); font-weight:600; }
  .thumbs img { height:54px; border-radius:6px; margin-right:4px; }
  .scroll { overflow-x:auto; }
</style></head><body>
<header><h1>Fall Detection Viewer</h1><span id="summary">connecting…</span></header>
<main>
  <section><div class="grid" id="cams"></div></section>
  <section><h2>Recent incidents</h2><div class="scroll"><table>
    <thead><tr><th>Status</th><th>Severity</th><th>Started</th><th>Down for</th><th>Zone</th><th>Cameras</th><th>Photos</th></tr></thead>
    <tbody id="incidents"></tbody></table></div></section>
</main>
<script>
const cards = new Map();
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const t = iso => iso ? new Date(iso).toLocaleTimeString() : "";
function secs(a, b) { if (!a) return ""; const s = Math.round(((b ? new Date(b) : new Date()) - new Date(a)) / 1000); return s < 60 ? s + " s" : Math.floor(s/60) + " min " + (s%60) + " s"; }
function card(cam) {
  let c = cards.get(cam.id);
  if (!c) {
    c = document.createElement("div"); c.className = "card";
    c.innerHTML = `<img alt="camera ${esc(cam.id)}"><div class="meta"><div class="cam"></div><div class="people"></div></div>`;
    const img = c.querySelector("img"), url = "/stream/" + encodeURIComponent(cam.id);
    img.src = url; img.onerror = () => setTimeout(() => img.src = url + "?r=" + Date.now(), 2000);
    c.querySelector(".cam").textContent = cam.id;
    document.getElementById("cams").appendChild(c); cards.set(cam.id, c);
  }
  const people = cam.people.length
    ? cam.people.map(p => `<span class="chip ${p.label}">#${p.track} ${p.label} ${p.confidence.toFixed(2)}</span>`).join(" ")
    : `<span class="chip">nobody in view</span>`;
  c.querySelector(".people").innerHTML = people;
}
async function refresh() {
  try {
    const s = await (await fetch("/api/state")).json();
    const ids = new Set(s.cameras.map(c => c.id));
    for (const [id, c] of cards) if (!ids.has(id)) { c.remove(); cards.delete(id); }
    s.cameras.forEach(card);
    if (!s.cameras.length && !document.querySelector(".empty"))
      document.getElementById("cams").innerHTML = `<div class="empty">No cameras connected. Add one in the gateway (http://localhost:8080).</div>`;
    else if (s.cameras.length) document.querySelector(".empty")?.remove();
    const active = s.incidents.filter(i => i.status === "active").length;
    document.getElementById("summary").textContent =
      `${s.cameras.length} camera(s) · ${active} active incident(s) · updated ${new Date().toLocaleTimeString()}`;
    document.getElementById("incidents").innerHTML = s.incidents.length ? s.incidents.map(i => `<tr>
      <td class="st-${i.status}">${esc(i.status)}</td><td>${esc(i.severity)}</td><td>${t(i.started_at)}</td>
      <td>${secs(i.started_at, i.recovered_at || (i.status === "active" ? null : i.event_at))}</td>
      <td>${esc(i.zone || "")}</td><td class="cam">${i.camera_ids.map(esc).join("<br>")}</td>
      <td class="thumbs">${i.snapshots.map(n => `<a href="/snapshots/${encodeURIComponent(n)}" target="_blank"><img src="/snapshots/${encodeURIComponent(n)}"></a>`).join("")}</td></tr>`).join("")
      : `<tr><td colspan="7" class="empty">No incidents yet. Lie down in view for 3 seconds to test.</td></tr>`;
  } catch (e) { document.getElementById("summary").textContent = "viewer unreachable, retrying…"; }
}
refresh(); setInterval(refresh, 1500);
</script></body></html>
"""
