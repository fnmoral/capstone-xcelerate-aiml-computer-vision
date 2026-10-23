import { useNavigate, useSearchParams } from 'react-router-dom';
import { PageHeader } from '../../components/ui/PageHeader';
import { EmptyState } from '../../components/ui/EmptyState';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { api } from '../../services/api/fallguard';
import { Snapshot } from './Snapshot';
import { usePolling } from '../../services/api/usePolling';
import { alertBy, formatDuration, formatTime, secondsSince } from '../../lib/format';
import './events.css';

const FILTERS = [
  { value: '', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'unresolved', label: 'Unresolved' },
  { value: 'recovered', label: 'Recovered' },
  { value: 'false_positive', label: 'False positives' },
];

export default function EventsPage() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const camera = params.get('camera') ?? '';
  const navigate = useNavigate();
  const { data, error, loading } = usePolling(() => api.incidents({ status, camera_id: camera, limit: 200 }), 3000,
    [status, camera]);
  const incidents = data?.incidents ?? [];

  const setFilter = (value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set('status', value); else next.delete('status');
    setParams(next, { replace: true });
  };

  return (
    <>
      <PageHeader title="Fall Events"
        description="Every fall the detector confirmed: when it happened, how long the person was down, and who has handled it." />
      <div className="tabs" role="group" aria-label="Filter by status">
        {FILTERS.map((f) => (
          <button key={f.value} className="tab" aria-pressed={status === f.value} onClick={() => setFilter(f.value)}>{f.label}</button>
        ))}
        {camera && (
          <button className="tab" aria-pressed onClick={() => { const n = new URLSearchParams(params); n.delete('camera'); setParams(n); }}>
            One camera ✕
          </button>
        )}
      </div>
      {error && <p className="notice notice--error">{error}</p>}
      {loading && !data ? <p className="muted">Loading…</p> : incidents.length === 0 ? (
        <EmptyState icon="alert" title="No fall events" body={status ? 'Nothing with this status.' : 'Confirmed falls appear here within seconds.'} />
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Photo</th><th>Status</th><th>Severity</th><th>Started</th><th className="num">Down for</th>
                <th>Where</th><th>Alert</th>
              </tr>
            </thead>
            <tbody>
              {incidents.map((i) => (
                <tr key={i.id} className="is-link" onClick={() => navigate(`/events/${i.id}`)}
                  onKeyDown={(e) => e.key === 'Enter' && navigate(`/events/${i.id}`)} tabIndex={0}>
                  <td><Snapshot snapshotKey={i.snapshot_key} className="ev-thumb" /></td>
                  <td><StatusBadge value={i.status} /></td>
                  <td><StatusBadge value={i.severity} /></td>
                  <td>{formatTime(i.started_at)}</td>
                  <td className="num">
                    {i.status === 'active' ? <strong>{formatDuration(secondsSince(i.started_at))}</strong>
                      : i.status === 'unresolved' && i.duration_seconds === null ? <span className="muted">out of view</span>
                      : formatDuration(i.duration_seconds)}
                  </td>
                  <td>
                    <div>{i.location_label ?? i.camera_name ?? 'Unknown camera'}</div>
                    <div className="muted ev-sub">{[i.zone && `Zone: ${i.zone}`, i.cameras.length > 1 && `${i.cameras.length} cameras`].filter(Boolean).join(' · ')}</div>
                  </td>
                  <td>
                    {i.alert ? <StatusBadge value={i.alert.status} /> : <span className="muted">—</span>}
                    {(i.alert?.closed_at || i.alert?.acknowledged_at) && (
                      <div className="muted ev-sub">
                        {i.alert.closed_at ? alertBy(i.alert.closed_by, i.alert.closed_at) : alertBy(i.alert.acknowledged_by, i.alert.acknowledged_at)}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
