import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import JMuxer from "jmuxer";
import { Link } from "react-router-dom";
import { StatusBadge } from "../../components/ui/StatusBadge";
import { streamHubUrl } from "../../services/api/client";
import type { Camera } from "../../types/domain";
import { formatTime, LABEL_TEXT } from "../../lib/format";
import "./CameraGrid.css";

const PLACEHOLDER: Record<string, string> = {
  paused: "Paused. Resume it in Cameras to watch.",
  not_connected: "Not connected to a gateway.",
  connecting: "Waiting for video…",
};

/** Browsers keep only ~6 connections per site open; WebSockets use a persistent upgraded connection. */
export const MAX_LIVE_STREAMS = 4;
const SNAPSHOT_MS = 1000;

function nalInfo(buf: Uint8Array) {
  const out: { h264: number; h265: number }[] = [];
  for (let i = 0; i + 4 < buf.length; i++) {
    const sc4 =
      buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 1;
    const sc3 = buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1;
    if (sc4 || sc3) {
      const h = buf[i + (sc4 ? 4 : 3)];
      out.push({ h264: h & 0x1f, h265: (h >> 1) & 0x3f });
    }
  }
  return out;
}

/**
 * Video Component: Conectado por WebSocket para recibir streams H.264 en tiempo real
 * o snapshots de respaldo cuando live=false.
 */
function Video({
  cam,
  live,
  tenantId,
}: {
  cam: Camera;
  live: boolean;
  tenantId?: string;
}) {
  // const [snapshotSrc, setSnapshotSrc] = useState<string | null>(null);
  // const videoRef = useRef<HTMLVideoElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const jmuxerRef = useRef<any>(null);
  const [snapshotSrc, setSnapshotSrc] = useState<string | null>(null);
  // ID único para que JMuxer pueda encontrar el elemento de video en el DOM
  const videoElementId = `jmuxer-video-${cam.id}`;
  // Lógica para el modo Live mediante WebSocket
  useEffect(() => {
    if (!live) return;
    const video = videoRef.current;
    if (!video) return;

    // 1. Inicializar JMuxer para manejar los NALUs H.264 crudos que vienen del WebSocket
    const jmuxer = new JMuxer({
      node: video,
      mode: "video",
      flushingTime: 0,
      fps: 30,
      debug: false,
    });

    // Construir la URL del WebSocket basada en el entorno actual
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    // Si usas el proxy de Vite o puerto 9000 directamente:
    const wsHost =
      window.location.hostname === "localhost"
        ? "localhost:9000"
        : window.location.host;
    // const wsUrl = `${protocol}//${wsHost}/ws/${tenantId}/${cam.id}`;
    // const wsUrl = `${protocol}//${wsHost}/stream-hub/ws/tenant_example/${cam.id}`;
    // const wsUrl = streamHubUrl(`/ws/${tenantId}/${cam.id}`);
    const wsUrl = streamHubUrl(`/ws/tenant_example/${cam.id}`);
    let disposed = false;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";

    // ws.onmessage = (event) => {
    //   if (event.data instanceof ArrayBuffer) {
    //     jmuxer.feed({ video: new Uint8Array(event.data) });
    //   }
    // };
    let n = 0;
    ws.onmessage = (event) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      const data = new Uint8Array(event.data);
      if (n++ < 15) {
        console.log(
          "bytes:",
          data.length,
          "head:",
          Array.from(data.slice(0, 8)),
          nalInfo(data),
        );
      }
      jmuxer.feed({ video: data });
    };
    ws.onerror = (e) => {
      if (!disposed) console.error("Video WebSocket error:", e);
    };

    return () => {
      disposed = true;
      ws.close();
      jmuxer.destroy();
    };
  }, [cam.id, live, tenantId]);

  if (live) {
    return (
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        style={{ width: "100%", height: "100%", objectFit: "cover" }}
      />
    );
  }

  return snapshotSrc ? (
    <img
      src={snapshotSrc}
      alt={`Video from ${cam.name}`}
      style={{ width: "100%", height: "100%", objectFit: "cover" }}
    />
  ) : null;
}

export function CameraTile({
  cam,
  live = true,
  fill = false,
  onSelect,
}: {
  cam: Camera;
  live?: boolean;
  fill?: boolean;
  onSelect?: (id: string) => void;
}) {
  const watching = cam.on_gateway && cam.status !== "paused";
  const down = cam.people.filter((p) => p.label !== "upright");
  // const broken = cam.health === "not_working";
  const broken = false;
  const flagged = broken && cam.alert_offline;

  const placeholder = broken
    ? `No video since ${formatTime(cam.health_since)}. Check the camera's power and network.`
    : (PLACEHOLDER[cam.health] ?? "Waiting for video…");
  const select = onSelect && (() => onSelect(cam.id));
  const onKey = (e: KeyboardEvent) => {
    if (select && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      select();
    }
  };
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

  const classes = [
    "cam-tile",
    "card",
    fill && "cam-tile--fill",
    cam.active_incidents ? "cam-tile--alert" : flagged && "cam-tile--down",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <li className={classes}>
      <div
        className={`cam-tile__video${select ? " is-selectable" : ""}`}
        onClick={select}
        onKeyDown={onKey}
        role={select ? "button" : undefined}
        tabIndex={select ? 0 : undefined}
        aria-label={select ? `Show ${cam.name} larger` : undefined}
      >
        {/* {watching && cam.live ? ( */}
        {watching ? (
          <Video cam={cam} live={live} />
        ) : (
          <p className="cam-tile__placeholder">{placeholder}</p>
        )}
        <span className="cam-tile__overlay">
          <StatusBadge
            value={cam.health}
            label={
              cam.health === "online"
                ? live
                  ? "Live"
                  : "Live · 1 fps"
                : undefined
            }
          />
        </span>
        {cam.active_incidents > 0 ? (
          <Link
            to={`/events?status=active&camera=${encodeURIComponent(cam.id)}`}
            className="cam-tile__incident"
            onClick={stop}
          >
            Fall detected: {cam.active_incidents} active
          </Link>
        ) : (
          flagged && (
            <Link
              to={`/camera-logs?camera=${encodeURIComponent(cam.id)}`}
              className="cam-tile__incident cam-tile__incident--down"
              onClick={stop}
            >
              Camera not working since {formatTime(cam.health_since)}
            </Link>
          )
        )}
      </div>
      <div className="cam-tile__meta">
        <div>
          <strong>{cam.name}</strong>
          <span className="muted">
            {[cam.location, cam.zone && `Zone: ${cam.zone}`]
              .filter(Boolean)
              .join(" · ") || "No location set"}
          </span>
        </div>
        <div className="cam-tile__people" aria-label="People in view">
          {cam.live &&
            watching &&
            (cam.people.length === 0 ? (
              <span className="muted">Nobody in view</span>
            ) : (
              cam.people.map((p) => (
                <StatusBadge
                  key={p.track}
                  value={p.label}
                  label={`#${p.track} ${LABEL_TEXT[p.label] ?? p.label}`}
                />
              ))
            ))}
        </div>
      </div>
      {down.length > 0 && (
        <span className="visually-hidden">{down.length} person(s) down</span>
      )}
    </li>
  );
}

export function useFitHeight<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [height, setHeight] = useState<number>();
  const measure = () => {
    if (!ref.current) return;
    const top = ref.current.getBoundingClientRect().top + window.scrollY;
    setHeight(Math.max(320, Math.floor(window.innerHeight - top - 24)));
  };
  useLayoutEffect(measure);
  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  return { ref, height };
}

function useNarrow() {
  const query = "(max-width: 720px)";
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setNarrow(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return narrow;
}

function gridShape(slots: number, narrow: boolean): [number, number] {
  let cols =
    slots <= 1
      ? 1
      : slots === 2
        ? 2
        : slots <= 4
          ? 2
          : slots <= 8
            ? 4
            : Math.ceil(Math.sqrt(slots));
  if (narrow) cols = Math.min(cols, slots === 2 ? 1 : 2);
  return [cols, Math.ceil(slots / cols)];
}

export function CameraGrid({
  cameras,
  slots,
  onSelect,
}: {
  cameras: Camera[];
  slots?: number;
  onSelect?: (id: string) => void;
}) {
  const narrow = useNarrow();
  const { ref, height } = useFitHeight<HTMLUListElement>();
  const live = cameras.length <= MAX_LIVE_STREAMS;
  if (!slots) {
    return (
      <ul className="cam-grid" aria-label="Camera feeds">
        {cameras.map((c) => (
          <CameraTile key={c.id} cam={c} live={live} onSelect={onSelect} />
        ))}
      </ul>
    );
  }
  const [cols, rows] = gridShape(slots, narrow);
  const style: CSSProperties = {
    gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
    gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
    height,
  };
  return (
    <ul
      ref={ref}
      className="cam-grid cam-grid--fit"
      style={style}
      aria-label="Camera feeds"
    >
      {cameras.map((c) => (
        <CameraTile key={c.id} cam={c} live={live} fill onSelect={onSelect} />
      ))}
    </ul>
  );
}
