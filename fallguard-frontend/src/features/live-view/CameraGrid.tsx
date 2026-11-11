import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { Link } from "react-router-dom";
import { StatusBadge } from "../../components/ui/StatusBadge";
import { streamHubUrl } from "../../services/api/client";
import type { Camera } from "../../types/domain";
import { formatTime, LABEL_TEXT } from "../../lib/format";
import { LiveVideo } from "./live/LiveVideo";
import "./CameraGrid.css";

const PLACEHOLDER: Record<string, string> = {
  paused: "Paused. Resume it in Cameras to watch.",
  not_connected: "Not connected to a gateway.",
  connecting: "Waiting for video…",
};

/** Browsers keep only ~6 connections per site open; WebSockets use a persistent upgraded connection. */
export const MAX_LIVE_STREAMS = 4;

/**
 * Live camera video (stream-hub WebSocket, protocol v2) with the fall-detection boxes,
 * or a snapshot when live=false.
 */
function Video({ cam, live }: { cam: Camera; live: boolean }) {
  const [snapshotSrc] = useState<string | null>(null);

  if (live) {
    return (
      <LiveVideo
        url={streamHubUrl(`/ws/${cam.tenant_id}/${cam.id}?v=2`)}
        label={`Live video from ${cam.name}`}
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
  // Only lying/falling count as down; "unclear" (too little visible) is not a fall.
  const down = cam.people.filter(
    (p) => p.label === "lying" || p.label === "falling",
  );
  const broken = cam.health === "not_working";
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
        {/* Video comes straight from stream-hub, so it is shown even when the detector is
            down; the tile is then outlined as not working, because nobody is being watched. */}
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
