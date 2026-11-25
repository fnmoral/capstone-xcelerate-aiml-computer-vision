import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../components/ui/Icon';
import { api } from '../../services/api/fallguard';
import { LABEL_TEXT } from '../../lib/format';
import type { LiveOverlay } from '../../store/uiStore';
import type { Prediction } from '../../types/domain';
import type { DetectedPerson } from '../live-view/live/protocol';
import { drawGrid, drawPeople, type Rect } from '../live-view/live/draw';

/**
 * Incident videos: the incident's person drawn over the video (box, status, number, skeleton...),
 * from the detector's once-a-second records of that person (model_predictions). Only this
 * incident's person: someone else in the picture has their own incident.
 */

/** One stored detector record of the incident's person, in the camera's pixels. */
export interface Sample {
  ms: number;
  box: [number, number, number, number];
  keypoints: [number, number, number][] | null;
  label: string;
  confidence: number;
  track: number;
}

/** A camera's records that carry a box, oldest first. */
export function samplesFor(predictions: Prediction[], cameraId: string): Sample[] {
  const out: Sample[] = [];
  for (const p of predictions) {
    const o = p.output as { box?: number[]; keypoints?: number[][]; track_id?: number } | null;
    if (p.camera_id !== cameraId || !o?.box || o.box.length !== 4) continue;
    out.push({
      ms: Date.parse(p.at),
      box: o.box as Sample['box'],
      keypoints: Array.isArray(o.keypoints) && o.keypoints.length === 17 ? (o.keypoints as Sample['keypoints']) : null,
      label: p.label,
      confidence: p.confidence,
      track: o.track_id ?? 0,
    });
  }
  return out.sort((a, b) => a.ms - b.ms);
}

const MAX_GAP_MS = 2500; // records further apart than this are not blended (the person was out of sight)
const HOLD_MS = 1200; // a record is still shown this long after it, when no next one follows soon

/** Where the person is at time ms, blended between the records around it; null when unknown. */
export function personAt(samples: Sample[], ms: number, width: number, height: number): DetectedPerson | null {
  if (samples.length === 0 || width <= 0 || height <= 0) return null;
  let hi = samples.findIndex((s) => s.ms > ms);
  if (hi === -1) hi = samples.length;
  const a = samples[hi - 1];
  const b = samples[hi];
  if (!a) return b && b.ms - ms <= 300 ? toPerson(b, b, 0, width, height) : null;
  if (b && b.ms - a.ms <= MAX_GAP_MS) return toPerson(a, b, (ms - a.ms) / (b.ms - a.ms), width, height);
  return ms - a.ms <= HOLD_MS ? toPerson(a, a, 0, width, height) : null;
}

const lerp = (x: number, y: number, f: number) => x + (y - x) * f;

function toPerson(a: Sample, b: Sample, f: number, w: number, h: number): DetectedPerson {
  const box = a.box.map((v, i) => lerp(v, b.box[i], f) / (i % 2 === 0 ? w : h)) as DetectedPerson['box'];
  let keypoints: DetectedPerson['keypoints'];
  if (a.keypoints) {
    const kb = b.keypoints ?? a.keypoints;
    keypoints = a.keypoints.map((k, i) => [lerp(k[0], kb[i][0], f) / w, lerp(k[1], kb[i][1], f) / h, Math.min(k[2], kb[i][2])]);
  }
  const near = f < 0.5 ? a : b;
  return { track: near.track, label: near.label, confidence: near.confidence, box, keypoints } as DetectedPerson;
}

/** Where a srcW x srcH video is shown inside dstW x dstH (object-fit: contain, the video default). */
function containRect(srcW: number, srcH: number, dstW: number, dstH: number): Rect {
  const scale = Math.min(dstW / srcW, dstH / srcH);
  const w = srcW * scale;
  const h = srcH * scale;
  return { x: (dstW - w) / 2, y: (dstH - h) / 2, w, h };
}

const labelText = (l: string) => LABEL_TEXT[l] ?? l;

/** A canvas over the video drawing the incident's person at the video's current time. */
export function OverlayCanvas({ video, startMs, samples, overlay }: {
  video: HTMLVideoElement; startMs: number; samples: Sample[]; overlay: LiveOverlay;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = canvas.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    let frame = 0;
    const draw = () => {
      const ratio = window.devicePixelRatio || 1;
      const w = Math.round(video.clientWidth * ratio);
      const h = Math.round(video.clientHeight * ratio);
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
      }
      ctx.clearRect(0, 0, w, h);
      if (!video.videoWidth || !video.videoHeight) return;
      const area = containRect(video.videoWidth, video.videoHeight, w, h);
      if (overlay.grid) drawGrid(ctx, area, ratio);
      const person = personAt(samples, startMs + video.currentTime * 1000, video.videoWidth, video.videoHeight);
      if (person) drawPeople(ctx, area, [person], labelText, ratio, overlay);
    };
    const loop = () => {
      draw();
      frame = video.paused || video.ended ? 0 : requestAnimationFrame(loop);
    };
    const play = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(loop);
    };
    const events = ['seeked', 'loadeddata', 'pause', 'timeupdate'];
    events.forEach((e) => video.addEventListener(e, draw));
    video.addEventListener('play', play);
    const resize = new ResizeObserver(draw);
    resize.observe(video);
    draw();
    if (!video.paused) play();
    return () => {
      cancelAnimationFrame(frame);
      events.forEach((e) => video.removeEventListener(e, draw));
      video.removeEventListener('play', play);
      resize.disconnect();
    };
  }, [video, startMs, samples, overlay]);

  return <canvas ref={canvas} className="ev-overlay" aria-hidden="true" />;
}

const OPTIONS: { key: keyof LiveOverlay; label: string; hint: string }[] = [
  { key: 'boxes', label: 'Person box', hint: 'A box around the person of this incident, coloured by status' },
  { key: 'label', label: 'Status', hint: 'Upright, Falling, Lying or Unclear' },
  { key: 'track', label: 'Person number', hint: "The detector's number for the person (#6), as in Fall Events" },
  { key: 'confidence', label: 'Confidence score', hint: 'How sure the detector is of the status' },
  { key: 'center', label: 'Center point', hint: 'The middle of the person\'s box' },
  { key: 'skeleton', label: 'Skeleton lines', hint: 'Lines joining the body points the fall rules use' },
  { key: 'keypoints', label: 'Body points', hint: 'The 17 points: eyes, shoulders, hips, knees, ankles...' },
  { key: 'grid', label: 'Grid lines', hint: 'An 8 × 8 grid over the picture' },
];

const same = (a: LiveOverlay, b: LiveOverlay) => OPTIONS.every((o) => a[o.key] === b[o.key]);

/** "Overlays" button of an incident's video: each overlay on/off, and the organization's default. */
export function IncidentOverlayMenu({ value, onChange, orgDefault, canSetDefault, onDefaultSaved }: {
  value: LiveOverlay; onChange: (o: LiveOverlay) => void; orgDefault: LiveOverlay;
  canSetDefault: boolean; onDefaultSaved: (o: LiveOverlay) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const shown = OPTIONS.filter((o) => value[o.key]).length;
  const isDefault = same(value, orgDefault);
  const saveDefault = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await api.saveIncidentOverlay(value);
      onDefaultSaved(value);
      setMsg('Saved as the organization default.');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay-menu" ref={ref}>
      <button className="btn btn--sm" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen(!open)}
        title="Show this incident's person on the video">
        <Icon name="layers" size={14} /> Overlays <span className="muted">({shown})</span>
      </button>
      {open && (
        <div className="overlay-menu__panel card" role="group" aria-label="Video overlays">
          <p className="muted overlay-menu__note" style={{ marginTop: 0 }}>Drawn for this incident's person only.</p>
          {OPTIONS.map((o) => (
            <label key={o.key} className="overlay-menu__option" title={o.hint}>
              <input type="checkbox" checked={value[o.key]} onChange={(e) => onChange({ ...value, [o.key]: e.target.checked })} />
              <span>{o.label}<small>{o.hint}</small></span>
            </label>
          ))}
          <div className="overlay-menu__actions">
            {isDefault ? (
              <span className="muted">The organization's default</span>
            ) : (
              <>
                {canSetDefault && (
                  <button className="btn btn--sm btn--primary" disabled={busy} onClick={() => void saveDefault()}>
                    Set as organization default
                  </button>
                )}
                <button className="btn btn--sm" onClick={() => onChange(orgDefault)}>Back to default</button>
              </>
            )}
          </div>
          {msg && <p className="overlay-menu__note" role="status">{msg}</p>}
          <p className="muted overlay-menu__note">
            The default is what everyone sees first on every incident video{canSetDefault ? '' : ' (admins set it)'}.
          </p>
        </div>
      )}
    </div>
  );
}
