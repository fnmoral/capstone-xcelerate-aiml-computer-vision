import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { PageHeader } from '../../components/ui/PageHeader';
import { EmptyState } from '../../components/ui/EmptyState';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { api } from '../../services/api/fallguard';
import { Snapshot } from './Snapshot';
import { usePolling } from '../../services/api/usePolling';
import { alertBy, formatDuration, formatTime, secondsSince } from '../../lib/format';
import type { Incident } from '../../types/domain';
import { Icon } from '../../components/ui/Icon';
import { useAuth } from '../auth/AuthContext';
import { DeleteEventDialog } from './DeleteEventDialog';
import './events.css';

/** The detector's number for the person ("#6"), per camera when several saw them. */
function personLabel(i: Incident) {
  const ids = [...new Set(i.cameras.filter((c) => c.track_id > 0).map((c) => `#${c.track_id}`))];
  return ids.length ? ids.join(', ') : <span className="muted">—</span>;
}

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
  const superAdmin = !!useAuth().me?.user.super_admin;
  const [toDelete, setToDelete] = useState<Incident | null>(null);
  const [deleted, setDeleted] = useState<string | null>(null);
  const { data, error, loading, reload } = usePolling(() => api.incidents({ status, camera_id: camera, limit: 200 }), 3000,
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
      {deleted && <p className="notice" role="status">{deleted}</p>}
      <DeleteEventDialog incident={toDelete} onClose={() => setToDelete(null)} onDeleted={(mode) => {
        setToDelete(null);
        setDeleted(mode === 'bin' ? 'Fall event moved to the bin. Restore it from Manage organizations → Fall event bin.' : 'Fall event deleted permanently.');
        void reload();
      }} />
      {loading && !data ? <p className="muted">Loading…</p> : incidents.length === 0 ? (
        <EmptyState icon="alert" title="No fall events" body={status ? 'Nothing with this status.' : 'Confirmed falls appear here within seconds.'} />
      ) : (
        <div className="card table-wrap">
          <table className="table table--stack">
            <thead>
              <tr>
                <th>Photo</th><th>Status</th><th>Severity</th><th>Started</th><th className="num">Down for</th>
                <th>Where</th><th title="The detector's number for the person on that camera">Person</th><th>Alert</th><th>Notes</th>
                {superAdmin && <th className="num"><span className="visually-hidden">Delete</span></th>}
              </tr>
            </thead>
            <tbody>
              {incidents.map((i) => (
                <tr key={i.id} className="is-link" onClick={() => navigate(`/events/${i.id}`)}
                  onKeyDown={(e) => e.key === 'Enter' && navigate(`/events/${i.id}`)} tabIndex={0}>
                  <td>
                    <span className="ev-thumb-wrap">
                      <Snapshot snapshotKey={i.snapshot_key} className="ev-thumb" />
                      {i.clip_key && <span className="ev-thumb-play" aria-label="Has video">▶</span>}
                    </span>
                  </td>
                  <td><StatusBadge value={i.status} /></td>
                  <td><StatusBadge value={i.severity} /></td>
                  <td>{formatTime(i.started_at)}</td>
                  <td className="num">
                    {i.status === 'active' ? <strong>{formatDuration(secondsSince(i.started_at))}</strong>
                      : i.status === 'unresolved' && i.duration_seconds === null ? <span className="muted">out of view</span>
                      : formatDuration(i.duration_seconds)}
                  </td>
                  <td>
                    <div>{i.location_label || i.camera_name || 'Unknown camera'}</div>
                    <div className="muted ev-sub">{[i.zone && `Zone: ${i.zone}`, i.cameras.length > 1 && `${i.cameras.length} cameras`].filter(Boolean).join(' · ')}</div>
                  </td>
                  <td>{personLabel(i)}</td>
                  <td>
                    {i.alert ? <StatusBadge value={i.alert.status} /> : <span className="muted">—</span>}
                    {(i.alert?.closed_at || i.alert?.acknowledged_at) && (
                      <div className="muted ev-sub">
                        {i.alert.closed_at ? alertBy(i.alert.closed_by, i.alert.closed_at) : alertBy(i.alert.acknowledged_by, i.alert.acknowledged_at)}
                      </div>
                    )}
                  </td>
                  <td className="ev-note-cell">
                    {i.note_list.length === 0 ? <span className="muted">—</span> : (
                      <>
                        <div className="ev-note-snippet">{i.note_list[i.note_list.length - 1].text}</div>
                        <div className="muted ev-sub">
                          {i.note_list.length > 1 ? `${i.note_list.length} notes · ` : ''}{i.note_list[i.note_list.length - 1].author}
                        </div>
                      </>
                    )}
                  </td>
                  {superAdmin && (
                    <td className="num">
                      <button className="btn btn--sm btn--danger" aria-label="Delete this fall event" title="Delete (super admins)"
                        onClick={(e) => { e.stopPropagation(); setToDelete(i); }} onKeyDown={(e) => e.stopPropagation()}>
                        <Icon name="trash" size={14} />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
