import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../services/api/fallguard';
import { usePolling } from '../../services/api/usePolling';
import { formatTime } from '../../lib/format';
import { useUiStore } from '../../store/uiStore';
import { Icon } from '../ui/Icon';
import { StatusBadge } from '../ui/StatusBadge';

/** Bell with what needs attention: open fall alerts and cameras that stopped working. */
export function NotificationsMenu() {
  const { data } = usePolling(() => api.notifications(), 5000);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { notifClearedAt, clearNotifications } = useUiStore();
  // Cleared = hidden here only, in this browser; the alerts stay open in Fall Events.
  const after = (iso: string | null) => !notifClearedAt || (iso ?? '') > notifClearedAt;
  const alerts = (data?.alerts ?? []).filter((a) => after(a.triggered_at));
  const cameras = (data?.cameras ?? []).filter((c) => after(c.status_since));
  const hidden = (data?.alerts.length ?? 0) + (data?.cameras.length ?? 0) - alerts.length - cameras.length;
  const count = alerts.length + cameras.length;

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const escape = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const close = () => setOpen(false);
  return (
    <div className="notif" ref={ref}>
      <button className="header__icon-btn header__bell" aria-expanded={open} aria-controls="notif-panel"
        aria-label={count ? `${count} notification${count > 1 ? 's' : ''}` : 'No notifications'}
        onClick={() => setOpen((o) => !o)}>
        <Icon name="bell" />
        {count > 0 && <span className="header__count">{count > 99 ? '99+' : count}</span>}
      </button>
      {open && (
        <div className="notif__panel card" id="notif-panel" role="region" aria-label="Notifications">
          <div className="notif__head">
            <h2 className="notif__title">Notifications</h2>
            <button className="btn btn--sm" disabled={count === 0} onClick={clearNotifications}
              title="Hide these here. The alerts stay open in Fall Events until someone acknowledges or resolves them.">
              Clear
            </button>
          </div>
          {count === 0 && (
            <p className="muted notif__empty">
              {hidden > 0 ? `Nothing new. ${hidden}${(data?.alerts.length ?? 0) >= 200 ? '+' : ''} cleared item${hidden > 1 ? 's are' : ' is'} still open in Fall Events.`
                : 'Nothing needs attention.'}
            </p>
          )}
          <ul className="notif__list">
            {cameras.map((c) => (
              <li key={'cam' + c.id}>
                <Link to={`/camera-logs?camera=${encodeURIComponent(c.id)}`} onClick={close} className="notif__item">
                  <StatusBadge value="not_working" label="Camera down" />
                  <span><strong>{c.name}</strong> stopped working</span>
                  <span className="muted notif__sub">since {formatTime(c.status_since)}{c.location ? ` · ${c.location}` : ''}</span>
                </Link>
              </li>
            ))}
            {alerts.map((a) => (
              <li key={'alert' + a.id}>
                <Link to={a.incident_id ? `/events/${a.incident_id}` : '/events'} onClick={close} className="notif__item">
                  <StatusBadge value="open" label="Fall alert" />
                  <span>{a.summary ?? `Fall detected on ${a.camera_name ?? 'a camera'}`}</span>
                  <span className="muted notif__sub">
                    {formatTime(a.triggered_at)} · {a.camera_name ?? 'Unknown camera'} · severity {a.severity} · not acknowledged
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <div className="notif__footer">
            <Link to="/events" onClick={close}>All fall events</Link>
            <Link to="/camera-logs" onClick={close}>Camera logs</Link>
          </div>
        </div>
      )}
    </div>
  );
}
