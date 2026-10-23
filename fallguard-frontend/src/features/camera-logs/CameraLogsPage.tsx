import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '../../components/ui/PageHeader';
import { EmptyState } from '../../components/ui/EmptyState';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { Icon } from '../../components/ui/Icon';
import { DEFAULT_WINDOW, resolveWindow, TimeWindow, type TimeWindowValue } from '../../components/ui/TimeWindow';
import { api, exportUrl } from '../../services/api/fallguard';
import { usePolling } from '../../services/api/usePolling';
import { formatDateTime, formatDuration, formatTime, secondsSince } from '../../lib/format';
import type { LogEntry } from '../../types/domain';
import './camera-logs.css';

/** Badge for each kind of camera log line (status changes carry the status color). */
const ACTION_BADGE: Record<string, { value: string; label: string }> = {
  'camera.online': { value: 'online', label: 'Online' },
  'camera.resumed': { value: 'online', label: 'Resumed' },
  'camera.not_working': { value: 'not_working', label: 'Not working' },
  'camera.paused': { value: 'paused', label: 'Paused' },
  'camera.not_connected': { value: 'not_connected', label: 'Not connected' },
  'camera.added': { value: 'muted', label: 'Added' },
  'camera.removed': { value: 'muted', label: 'Removed' },
  'camera.updated': { value: 'muted', label: 'Edited' },
  'camera.alert_on': { value: 'muted', label: 'Setting' },
  'camera.alert_off': { value: 'muted', label: 'Setting' },
};

function LogRow({ e }: { e: LogEntry }) {
  const badge = ACTION_BADGE[e.action] ?? { value: 'muted', label: e.action.replace('camera.', '') };
  return (
    <tr>
      <td className="cl-time">{formatDateTime(e.at)}</td>
      <td>{e.camera_name ?? <span className="muted">Removed camera</span>}</td>
      <td><StatusBadge value={badge.value} label={badge.label} /></td>
      <td>{e.message}</td>
      <td>{e.actor ?? <span className="muted">System</span>}</td>
    </tr>
  );
}

export default function CameraLogsPage() {
  const [params, setParams] = useSearchParams();
  const cameraId = params.get('camera') ?? '';
  const [range, setRange] = useState<TimeWindowValue>(DEFAULT_WINDOW);
  const cams = usePolling(() => api.cameras(), 5000);
  const logs = usePolling(() => api.logs({ kind: 'camera', camera_id: cameraId, limit: 500, ...resolveWindow(range) }), 10000,
    [cameraId, JSON.stringify(range)]);
  const cameras = cams.data?.cameras ?? [];
  const entries = logs.data?.entries ?? [];

  const setCamera = (id: string) => {
    const next = new URLSearchParams(params);
    if (id) next.set('camera', id); else next.delete('camera');
    setParams(next, { replace: true });
  };

  return (
    <>
      <PageHeader title="Camera Logs"
        description="When each camera was online, paused or not working, and who changed it. Kept for audits; export it as CSV." />

      <section className="card cl-section">
        <h2 className="section-title">Right now</h2>
        {cams.error && <p className="notice notice--error">{cams.error}</p>}
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Camera</th><th>Status</th><th>Since</th><th className="num">For</th><th>Alert if not working</th><th /></tr>
            </thead>
            <tbody>
              {cameras.map((c) => (
                <tr key={c.id} className={c.health === 'not_working' && c.alert_offline ? 'cl-down' : undefined}>
                  <td><strong>{c.name}</strong><div className="muted cl-sub">{c.location ?? 'No location'}</div></td>
                  <td><StatusBadge value={c.health} /></td>
                  <td>{formatTime(c.health_since)}</td>
                  <td className="num">{c.health_since ? formatDuration(secondsSince(c.health_since)) : '—'}</td>
                  <td>{c.on_gateway ? (c.alert_offline ? 'On' : <span className="muted">Off</span>) : <span className="muted">—</span>}</td>
                  <td><button className="btn btn--sm" aria-pressed={cameraId === c.id}
                    onClick={() => setCamera(cameraId === c.id ? '' : c.id)}>{cameraId === c.id ? 'Show all' : 'History'}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card cl-section">
        <h2 className="section-title">History</h2>
        <div className="filters cl-filters">
          <label className="field">Camera
            <select value={cameraId} onChange={(e) => setCamera(e.target.value)}>
              <option value="">All cameras</option>
              {cameras.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <TimeWindow value={range} onChange={setRange} />
          <a className="btn" href={exportUrl.logs({ kind: 'camera', camera_id: cameraId, ...resolveWindow(range) })} download>
            <Icon name="download" size={16} /> Export CSV
          </a>
        </div>
        {logs.error && <p className="notice notice--error">{logs.error}</p>}
        {logs.loading && !logs.data ? <p className="muted">Loading…</p> : entries.length === 0 ? (
          <EmptyState icon="log" title="Nothing logged in this window"
            body="Camera changes appear here: added, paused, resumed, stopped working, back online, removed." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Time</th><th>Camera</th><th>Status</th><th>What happened</th><th>By</th></tr></thead>
              <tbody>{entries.map((e, i) => <LogRow key={e.at + i} e={e} />)}</tbody>
            </table>
            {entries.length >= 500 && <p className="muted cl-sub">Showing the latest 500. Export for the full list.</p>}
          </div>
        )}
      </section>
    </>
  );
}
