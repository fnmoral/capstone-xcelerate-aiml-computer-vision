import { useState } from 'react';
import { Link } from 'react-router-dom';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { streamUrl } from '../../services/api/fallguard';
import type { Camera } from '../../types/domain';
import { formatTime, LABEL_TEXT } from '../../lib/format';
import './CameraGrid.css';

const PLACEHOLDER: Record<string, string> = {
  paused: 'Paused. Resume it in Cameras to watch.',
  not_connected: 'Not connected to a gateway.',
  connecting: 'Waiting for video…',
};

/** Annotated live video (MJPEG from ml-service, through the backend) with who is in view. */
function CameraTile({ cam }: { cam: Camera }) {
  const [attempt, setAttempt] = useState(0);
  const watching = cam.on_gateway && cam.status !== 'paused';
  const down = cam.people.filter((p) => p.label !== 'upright');
  const broken = cam.health === 'not_working';
  // Highlighted only when its "alert me" toggle is on; otherwise it just shows the status.
  const flagged = broken && cam.alert_offline;

  const placeholder = broken
    ? `No video since ${formatTime(cam.health_since)}. Check the camera's power and network.`
    : PLACEHOLDER[cam.health] ?? 'Waiting for video…';

  return (
    <li className={`cam-tile card${cam.active_incidents ? ' cam-tile--alert' : flagged ? ' cam-tile--down' : ''}`}>
      <div className="cam-tile__video">
        {watching && cam.live ? (
          <img key={attempt} src={`${streamUrl(cam.id)}?a=${attempt}`} alt={`Live video from ${cam.name}`}
            onError={() => window.setTimeout(() => setAttempt((n) => n + 1), 3000)} />
        ) : (
          <p className="cam-tile__placeholder">{placeholder}</p>
        )}
        <span className="cam-tile__overlay">
          <StatusBadge value={cam.health} label={cam.health === 'online' ? 'Live' : undefined} />
        </span>
        {cam.active_incidents > 0 ? (
          <Link to={`/events?status=active&camera=${encodeURIComponent(cam.id)}`} className="cam-tile__incident">
            Fall detected: {cam.active_incidents} active
          </Link>
        ) : flagged && (
          <Link to={`/camera-logs?camera=${encodeURIComponent(cam.id)}`} className="cam-tile__incident cam-tile__incident--down">
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

export function CameraGrid({ cameras }: { cameras: Camera[] }) {
  return (
    <ul className="cam-grid" aria-label="Camera feeds">
      {cameras.map((c) => <CameraTile key={c.id} cam={c} />)}
    </ul>
  );
}
