import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { apiUrl } from '../../services/api/client';
import { streamUrl } from '../../services/api/fallguard';
import type { Camera } from '../../types/domain';
import { formatTime, LABEL_TEXT } from '../../lib/format';
import './CameraGrid.css';

const PLACEHOLDER: Record<string, string> = {
  paused: 'Paused. Resume it in Cameras to watch.',
  not_connected: 'Not connected to a gateway.',
  connecting: 'Waiting for video…',
};

/** Browsers keep only ~6 connections per site open; each MJPEG stream holds one. With
 *  more tiles than this on screen, tiles show a picture refreshed every second instead. */
export const MAX_LIVE_STREAMS = 4;
const SNAPSHOT_MS = 1000;

/** Annotated video: a live MJPEG stream, or a once-a-second snapshot (see MAX_LIVE_STREAMS). */
function Video({ cam, live }: { cam: Camera; live: boolean }) {
  const [attempt, setAttempt] = useState(0);
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (live) return;
    let cancelled = false;
    let timer: number | undefined;
    const load = () => {
      const img = new Image(); // load off-screen, then swap: no flicker between pictures
      img.onload = () => { if (!cancelled) setSrc(img.src); timer = window.setTimeout(load, SNAPSHOT_MS); };
      img.onerror = () => { timer = window.setTimeout(load, SNAPSHOT_MS * 3); };
      img.src = apiUrl(`/cameras/${encodeURIComponent(cam.id)}/frame.jpg?t=${Date.now()}`);
    };
    load();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [cam.id, live]);

  if (live) {
    return <img key={attempt} src={`${streamUrl(cam.id)}?a=${attempt}`} alt={`Live video from ${cam.name}`}
      onError={() => window.setTimeout(() => setAttempt((n) => n + 1), 3000)} />;
  }
  return src ? <img src={src} alt={`Video from ${cam.name}, refreshed every second`} /> : null;
}

export function CameraTile({ cam, live = true, fill = false, onSelect }: {
  cam: Camera;
  live?: boolean; // MJPEG stream (true) or snapshots
  fill?: boolean; // fill its grid cell (fitted layouts, enlarged view) instead of a 16:9 card
  onSelect?: (id: string) => void;
}) {
  const watching = cam.on_gateway && cam.status !== 'paused';
  const down = cam.people.filter((p) => p.label !== 'upright');
  const broken = cam.health === 'not_working';
  // Highlighted only when its "alert me" toggle is on; otherwise it just shows the status.
  const flagged = broken && cam.alert_offline;

  const placeholder = broken
    ? `No video since ${formatTime(cam.health_since)}. Check the camera's power and network.`
    : PLACEHOLDER[cam.health] ?? 'Waiting for video…';
  const select = onSelect && (() => onSelect(cam.id));
  const onKey = (e: KeyboardEvent) => { if (select && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); select(); } };
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

  const classes = ['cam-tile', 'card', fill && 'cam-tile--fill', cam.active_incidents ? 'cam-tile--alert' : flagged && 'cam-tile--down']
    .filter(Boolean).join(' ');
  return (
    <li className={classes}>
      <div className={`cam-tile__video${select ? ' is-selectable' : ''}`} onClick={select} onKeyDown={onKey}
        role={select ? 'button' : undefined} tabIndex={select ? 0 : undefined}
        aria-label={select ? `Show ${cam.name} larger` : undefined}>
        {watching && cam.live ? <Video cam={cam} live={live} /> : <p className="cam-tile__placeholder">{placeholder}</p>}
        <span className="cam-tile__overlay">
          <StatusBadge value={cam.health} label={cam.health === 'online' ? (live ? 'Live' : 'Live · 1 fps') : undefined} />
        </span>
        {cam.active_incidents > 0 ? (
          <Link to={`/events?status=active&camera=${encodeURIComponent(cam.id)}`} className="cam-tile__incident" onClick={stop}>
            Fall detected: {cam.active_incidents} active
          </Link>
        ) : flagged && (
          <Link to={`/camera-logs?camera=${encodeURIComponent(cam.id)}`} className="cam-tile__incident cam-tile__incident--down" onClick={stop}>
            Camera not working since {formatTime(cam.health_since)}
          </Link>
        )}
      </div>
      <div className="cam-tile__meta">
        <div>
          <strong>{cam.name}</strong>
          <span className="muted">{[cam.location, cam.zone && `Zone: ${cam.zone}`].filter(Boolean).join(' · ') || 'No location set'}</span>
        </div>
        <div className="cam-tile__people" aria-label="People in view">
          {cam.live && watching && (cam.people.length === 0
            ? <span className="muted">Nobody in view</span>
            : cam.people.map((p) => (
              <StatusBadge key={p.track} value={p.label} label={`#${p.track} ${LABEL_TEXT[p.label] ?? p.label}`} />
            )))}
        </div>
      </div>
      {down.length > 0 && <span className="visually-hidden">{down.length} person(s) down</span>}
    </li>
  );
}

/** Height from the element's top to the bottom of the window, so a fitted grid never scrolls. */
export function useFitHeight<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [height, setHeight] = useState<number>();
  const measure = () => {
    if (!ref.current) return;
    const top = ref.current.getBoundingClientRect().top + window.scrollY; // from the top of the page
    setHeight(Math.max(320, Math.floor(window.innerHeight - top - 24)));
  };
  // Every render (the toolbar above can change height; same value = no re-render) and on resize.
  useLayoutEffect(measure);
  useEffect(() => {
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return { ref, height };
}

function useNarrow() {
  const query = '(max-width: 720px)';
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setNarrow(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return narrow;
}

/** Columns × rows for `slots` tiles: 2 side by side, 4 as 2×2, 8 as 4×2 (2×4 on a phone),
 *  any other count as close to square as possible. */
function gridShape(slots: number, narrow: boolean): [number, number] {
  let cols = slots <= 1 ? 1 : slots === 2 ? 2 : slots <= 4 ? 2 : slots <= 8 ? 4 : Math.ceil(Math.sqrt(slots));
  if (narrow) cols = Math.min(cols, slots === 2 ? 1 : 2);
  return [cols, Math.ceil(slots / cols)];
}

/**
 * Camera tiles. Without `slots`: as many columns as fit, page scrolls (the "Auto" layout).
 * With `slots`: a cols × rows grid sized to fill the rest of the window.
 */
export function CameraGrid({ cameras, slots, onSelect }: {
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
        {cameras.map((c) => <CameraTile key={c.id} cam={c} live={live} onSelect={onSelect} />)}
      </ul>
    );
  }
  const [cols, rows] = gridShape(slots, narrow);
  const style: CSSProperties = { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`, height };
  return (
    <ul ref={ref} className="cam-grid cam-grid--fit" style={style} aria-label="Camera feeds">
      {cameras.map((c) => <CameraTile key={c.id} cam={c} live={live} fill onSelect={onSelect} />)}
    </ul>
  );
}
