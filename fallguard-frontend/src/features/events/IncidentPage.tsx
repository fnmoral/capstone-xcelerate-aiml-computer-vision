import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { PageHeader } from '../../components/ui/PageHeader';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { Icon } from '../../components/ui/Icon';
import { api } from '../../services/api/fallguard';
import { usePolling } from '../../services/api/usePolling';
import { alertBy, byWhen, formatDuration, formatTime, LABEL_TEXT, secondsSince, shortId } from '../../lib/format';
import type { Incident, LogEntry, Prediction } from '../../types/domain';
import { IncidentVideos } from './IncidentVideos';
import { Notes } from './Notes';
import './events.css';

/** What the detector saw, second by second: one colored step per prediction. */
function Timeline({ predictions }: { predictions: Prediction[] }) {
  if (predictions.length === 0) return <p className="muted">No per-second data stored for this incident.</p>;
  return (
    <>
      <ol className="timeline" aria-label="Detector labels over time">
        {predictions.map((p, i) => (
          <li key={i} className={`timeline__step timeline__step--${p.label}`}
            title={`${formatTime(p.at)} · ${LABEL_TEXT[p.label] ?? p.label} (${p.confidence.toFixed(2)})`} />
        ))}
      </ol>
      <div className="row muted ev-sub">
        <span>{formatTime(predictions[0].at)}</span>
        <span style={{ flex: 1 }} />
        <span>{formatTime(predictions[predictions.length - 1].at)}</span>
      </div>
      <div className="row ev-legend">
        <StatusBadge value="upright" /> <StatusBadge value="falling" /> <StatusBadge value="lying" />
      </div>
    </>
  );
}

/** Who did what to this incident and its alert, newest first, ending with the detection itself. */
function History({ inc, activity }: { inc: Incident; activity: LogEntry[] }) {
  const lines = [
    ...activity.map((e) => ({ at: e.at, text: e.message, by: e.actor ?? 'System' })),
    ...(inc.alert ? [{ at: inc.alert.triggered_at, text: 'Alert raised', by: 'Detector' }] : []),
    { at: inc.started_at, text: 'Fall detected', by: 'Detector' },
  ].sort((a, b) => b.at.localeCompare(a.at));
  return (
    <ol className="history" aria-label="Incident history">
      {lines.map((l, i) => (
        <li key={i}><span>{l.text}</span><span className="history__by">{byWhen(l.by, l.at)}</span></li>
      ))}
    </ol>
  );
}

export default function IncidentPage() {
  const { id = '' } = useParams();
  const { data, error, reload } = usePolling(() => api.incident(id), 3000, [id]);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (error && !data) return <p className="notice notice--error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const { incident: inc, predictions, activity = [] } = data;
  const alert = inc.alert;
  const down = inc.status === 'active' ? secondsSince(inc.started_at) : inc.duration_seconds;

  return (
    <>
      <Link to="/events" className="row muted ev-back"><Icon name="back" size={16} /> All fall events</Link>
      <PageHeader title={`Fall in ${inc.location_label || inc.camera_name || 'unknown camera'}`}
        description={`Started ${formatTime(inc.started_at)} · incident ${shortId(inc.id)}`}
        actions={<><StatusBadge value={inc.status} /><StatusBadge value={inc.severity} label={`Severity: ${inc.severity}`} /></>} />
      {actionError && <p className="notice notice--error">{actionError}</p>}

      <div className="tiles">
        <div className="tile card"><div className="tile__label">{inc.status === 'active' ? 'Down for (still down)' : 'Down for'}</div>
          <div className="tile__value">{inc.status === 'unresolved' && down === null ? 'Unknown' : formatDuration(down)}</div>
          {inc.status === 'unresolved' && <div className="tile__hint">went out of view while down</div>}</div>
        <div className="tile card"><div className="tile__label">Recovered</div>
          <div className="tile__value" style={{ fontSize: 20 }}>
            {inc.recovered_at ? formatTime(inc.recovered_at) : inc.status === 'active' ? 'Not yet' : '—'}</div></div>
        <div className="tile card"><div className="tile__label">Peak confidence</div>
          <div className="tile__value">{inc.peak_confidence !== null ? inc.peak_confidence.toFixed(2) : '—'}</div></div>
        <div className="tile card"><div className="tile__label">Cameras</div>
          <div className="tile__value">{Math.max(1, inc.cameras.length)}</div>
          <div className="tile__hint">{inc.zone ? `Zone: ${inc.zone}` : 'No zone'}</div></div>
      </div>

      <div className="ev-layout">
        <div className="stack">
          <section className="card ev-section">
            <h2 className="section-title">Video</h2>
            <IncidentVideos inc={inc} />
          </section>
          <section className="card ev-section">
            <h2 className="section-title">What the detector saw</h2>
            <Timeline predictions={predictions} />
          </section>
        </div>

        <aside className="stack">
          <section className="card ev-section">
            <h2 className="section-title">Alert</h2>
            {!alert ? <p className="muted">No alert for this incident.</p> : (
              <>
                <p className="row"><StatusBadge value={alert.status} />
                  <span className="muted">triggered {formatTime(alert.triggered_at)}</span></p>
                {alert.summary && <p>{alert.summary}</p>}
                {alert.acknowledged_at && (
                  <p className="muted ev-sub">Acknowledged by {alertBy(alert.acknowledged_by, alert.acknowledged_at)}</p>
                )}
                {alert.status === 'resolved' && (
                  <p className="muted ev-sub">Resolved by {alertBy(alert.closed_by, alert.closed_at)}</p>
                )}
                {alert.status === 'false_positive' && (
                  <p className="muted ev-sub">Marked as a false alarm by {alertBy(alert.closed_by, alert.closed_at)}</p>
                )}
                <div className="row">
                  {alert.status === 'open' && (
                    <button className="btn btn--primary" disabled={busy} onClick={() => run(() => api.alertAction(alert.id, 'acknowledge'))}>
                      <Icon name="check" size={16} /> Acknowledge
                    </button>
                  )}
                  {(alert.status === 'open' || alert.status === 'acknowledged') && (
                    <button className="btn" disabled={busy} onClick={() => run(() => api.alertAction(alert.id, 'resolve'))}>Resolve</button>
                  )}
                  {(alert.status === 'open' || alert.status === 'acknowledged') && (
                    <button className="btn btn--danger" disabled={busy}
                      onClick={() => confirm('Mark this as a false alarm? It is left out of the statistics. You can undo this.') &&
                        run(() => api.alertAction(alert.id, 'false-positive'))}>False alarm</button>
                  )}
                </div>
              </>
            )}
          </section>
          <section className="card ev-section">
            <h2 className="section-title">History</h2>
            <History inc={inc} activity={activity} />
          </section>
          <section className="card ev-section">
            <h2 className="section-title">Notes ({inc.note_list.length})</h2>
            <Notes incidentId={inc.id} notes={inc.note_list} onAdded={reload} />
          </section>
          <section className="card ev-section">
            <h2 className="section-title">Cameras that saw it</h2>
            <ul className="ev-list">
              {(inc.cameras.length ? inc.cameras : [{ camera_id: inc.camera_id, camera_name: inc.camera_name, track_id: 0, joined_at: inc.started_at, snapshot_key: null }])
                .map((c) => (
                  <li key={c.camera_id + c.track_id}>
                    <strong>{c.camera_name ?? shortId(c.camera_id)}</strong>
                    <span className="muted ev-sub"> · person #{c.track_id} · from {formatTime(c.joined_at)}</span>
                  </li>
                ))}
            </ul>
          </section>
          {alert && (alert.status === 'resolved' || alert.status === 'false_positive') && (
            <section className="card ev-section ev-undo">
              <h2 className="section-title">Undo</h2>
              {alert.status === 'resolved' ? (
                <>
                  <p className="muted">Resolved by mistake? The alert goes back to how it was before.</p>
                  <button className="btn" disabled={busy} onClick={() => run(() => api.alertAction(alert.id, 'reopen'))}>Unresolve</button>
                </>
              ) : (
                <>
                  <p className="muted">Marked as a false alarm by mistake? It counts as a real fall again, in the statistics too.</p>
                  <button className="btn" disabled={busy} onClick={() => run(() => api.alertAction(alert.id, 'reopen'))}>
                    Not a false alarm (undo)
                  </button>
                </>
              )}
            </section>
          )}
        </aside>
      </div>
    </>
  );
}
