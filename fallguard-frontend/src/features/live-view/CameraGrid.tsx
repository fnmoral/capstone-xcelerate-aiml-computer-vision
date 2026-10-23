import type { Camera } from '../../types/domain';
import './CameraGrid.css';

/**
 * Responsive grid of camera tiles. Video playback is not wired yet:
 * it depends on the Streaming Module (Module 3) output format. [OPEN DESIGN DECISION]
 */
export function CameraGrid({ cameras }: { cameras: Camera[] }) {
  return (
    <ul className="cam-grid" aria-label="Camera feeds">
      {cameras.map((c) => (
        <li key={c.id} className="cam-tile card">
          <div className="cam-tile__video" role="img" aria-label={`Feed for ${c.name}`}>
            <span className={`cam-tile__status cam-tile__status--${c.status}`}>{c.status}</span>
          </div>
          <div className="cam-tile__meta">
            <strong>{c.name}</strong>
            <span>{c.location}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}
