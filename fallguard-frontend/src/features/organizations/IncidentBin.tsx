import { useState } from 'react';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { api } from '../../services/api/fallguard';
import { usePolling } from '../../services/api/usePolling';
import { formatTime } from '../../lib/format';
import type { BinnedIncident } from '../../types/domain';
import { Snapshot } from '../events/Snapshot';
import '../events/events.css';

/** Super admins: fall events moved to the bin, in every organization. Restore or delete for good. */
export function IncidentBin() {
  const { data, error: loadError, reload } = usePolling(() => api.incidentBin(), 30000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const list = data?.incidents ?? [];

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(done);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const where = (b: BinnedIncident) => b.location_label || b.camera_name || 'Unknown camera';
  const forever = (b: BinnedIncident) => {
    if (!confirm(`Delete the fall event at ${where(b)} (${formatTime(b.started_at)}) permanently?\n\nIts video, snapshots, alert, notifications, ${b.reports ? `${b.reports} incident report(s), ` : ''}share links and log entries are removed. No trace is left and it can't be undone.`)) return;
    void run(() => api.deleteBinnedIncident(b.id), 'Fall event deleted permanently.');
  };

  return (
    <section className="card orgs-list">
      <h2 className="section-title">Fall event bin ({list.length})</h2>
      <p className="muted orgs-note" style={{ marginTop: -4, marginBottom: 12 }}>
        Fall events a super admin deleted to the bin. They're hidden from Fall Events, alerts, analytics, reports and
        exports. Restoring one brings back the event, its video, reports and logs.
      </p>
      <p className="notice orgs-note" style={{ marginTop: 0 }}>
        Videos in the bin still follow the video server's clean-up: they're deleted after 30 days, like other videos.
      </p>
      {(error || loadError) && <p className="notice notice--error">{error || loadError}</p>}
      {notice && <p className="notice" role="status">{notice}</p>}
      {list.length === 0 ? <p className="muted">The bin is empty.</p> : (
        <div className="table-wrap">
          <table className="table table--stack">
            <thead><tr><th>Photo</th><th>Fall event</th><th>Organization</th><th>Status</th><th>Kept</th><th>Moved to bin</th><th /></tr></thead>
            <tbody>
              {list.map((b) => (
                <tr key={b.id}>
                  <td><Snapshot snapshotKey={b.snapshot_key} className="ev-thumb" /></td>
                  <td><strong>{where(b)}</strong><div className="muted ev-sub">{formatTime(b.started_at)}</div></td>
                  <td>{b.org_name}</td>
                  <td><StatusBadge value={b.status} /> <StatusBadge value={b.severity} /></td>
                  <td className="muted">{[b.has_video ? 'Video' : null, b.reports ? `${b.reports} report(s)` : null].filter(Boolean).join(' · ') || '—'}</td>
                  <td className="muted">{formatTime(b.deleted_at)}{b.deleted_by && <div className="ev-sub">by {b.deleted_by}</div>}</td>
                  <td className="num orgs-actions">
                    <button className="btn btn--sm btn--primary" disabled={busy}
                      onClick={() => void run(() => api.restoreIncident(b.id), `Fall event at ${where(b)} restored to ${b.org_name}'s Fall Events.`)}>Restore</button>
                    <button className="btn btn--sm btn--danger" disabled={busy} onClick={() => forever(b)}>Delete permanently</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
