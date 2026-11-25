import { useCallback, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { PageHeader } from '../../components/ui/PageHeader';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { Icon } from '../../components/ui/Icon';
import { api } from '../../services/api/fallguard';
import { usePolling } from '../../services/api/usePolling';
import { alertBy, byWhen, formatDuration, formatTime, LABEL_TEXT, secondsSince, shortId } from '../../lib/format';
import type { Incident, LogEntry, Prediction } from '../../types/domain';
import { IncidentVideos, type ClipPlayer } from './IncidentVideos';
import { IncidentOverlayMenu } from './IncidentOverlay';
import { useUiStore, type LiveOverlay } from '../../store/uiStore';
import { Notes } from './Notes';
import { IncidentReportsPanel } from '../incident-reports/IncidentReportsPanel';
import { ShareLinksPanel } from './ShareLinksPanel';
import { PERM, useAuth } from '../auth/AuthContext';
import './events.css';

/** Consecutive predictions with the same label: one stretch of the timeline. */
interface Run { label: string; from: string; to: string; count: number; camera: string }

function runsOf(predictions: Prediction[]): Run[] {
  const runs: Run[] = [];
  for (const p of predictions) {
    const last = runs[runs.length - 1];
    if (last && last.label === p.label) {
      last.to = p.at;
      last.count++;
    } else {
      runs.push({ label: p.label, from: p.at, to: p.at, count: 1, camera: p.camera_id });
    }
  }
  return runs;
}

const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/**
 * What the detector saw: one colored stretch per run of the same label. With the incident's
 * video loaded, clicking a stretch plays the video from that moment, and a line follows the video.
 */
function Timeline({ predictions, players, playheadMs }: {
  predictions: Prediction[]; players: Map<string, ClipPlayer>; playheadMs: number | null;
}) {
  if (predictions.length === 0) return <p className="muted">No per-second data stored for this incident.</p>;
  const runs = runsOf(predictions);
  const first = players.values().next().value as ClipPlayer | undefined;
  const approximate = [...players.values()].some((p) => p.approximate);

  const seek = (run: Run) => {
    const player = players.get(run.camera) ?? first;
    if (!player) return;
    const v = player.video;
    let t = (Date.parse(run.from) - player.startMs) / 1000;
    if (Number.isFinite(v.duration)) t = Math.min(t, Math.max(0, v.duration - 0.5));
    v.currentTime = Math.max(0, t);
    void v.play().catch(() => undefined);
    const r = v.getBoundingClientRect();
    if (r.top < 0 || r.bottom > window.innerHeight) v.scrollIntoView({ block: 'center', behavior: reduceMotion() ? 'auto' : 'smooth' });
  };

  // The line that follows the video: how far through the predictions its current time is.
  let playhead: number | null = null;
  if (playheadMs !== null) {
    const firstMs = Date.parse(predictions[0].at);
    const lastMs = Date.parse(predictions[predictions.length - 1].at);
    if (playheadMs >= firstMs && playheadMs <= lastMs + 2000) {
      const seen = predictions.filter((p) => Date.parse(p.at) <= playheadMs).length;
      playhead = (seen / predictions.length) * 100;
    }
  }

  return (
    <>
      <div className={`timeline${runs.length > 120 ? ' timeline--dense' : ''}${first ? ' timeline--seek' : ''}`}
        role="group" aria-label="Detector labels over time">
        {runs.map((r, i) => {
          const what = `${LABEL_TEXT[r.label] ?? r.label} from ${formatTime(r.from)}` +
            (r.count > 1 ? ` for ${formatDuration((Date.parse(r.to) - Date.parse(r.from)) / 1000 + 1)}` : '');
          return first ? (
            <button key={i} type="button" className={`timeline__step timeline__step--${r.label}`} style={{ flexGrow: r.count }}
              title={`${what}. Click to play the video from here.`} aria-label={`${what}: play the video from here`}
              onClick={() => seek(r)} />
          ) : (
            <span key={i} className={`timeline__step timeline__step--${r.label}`} style={{ flexGrow: r.count }} title={what} />
          );
        })}
        {playhead !== null && <span className="timeline__playhead" style={{ left: `${playhead}%` }} aria-hidden="true" />}
      </div>
      <div className="row muted ev-sub">
        <span>{formatTime(predictions[0].at)}</span>
        <span style={{ flex: 1 }} />
        <span>{formatTime(predictions[predictions.length - 1].at)}</span>
      </div>
      <div className="row ev-legend">
        <StatusBadge value="upright" /> <StatusBadge value="falling" /> <StatusBadge value="lying" /> <StatusBadge value="unclear" />
      </div>
      {first && (
        <p className="muted ev-sub ev-seek-hint">
          Click a color to play the video from that moment{approximate ? ' (approximately: this older video has no exact start time)' : ''}.
        </p>
      )}
    </>
  );
}

/** "person #6" (several cameras: "person #6, #3"), the detector's number for the incident's person. */
function persons(inc: Incident): string {
  const ids = [...new Set(inc.cameras.filter((c) => c.track_id > 0).map((c) => `#${c.track_id}`))];
  return ids.length ? `person ${ids.join(', ')}` : '';
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
  const { can } = useAuth();
  const respond = can(PERM.manageAlerts);
  const { data, error, reload } = usePolling(() => api.incident(id), 3000, [id]);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // The incident's videos (per camera) and where the one playing is, for the detector timeline.
  const [players, setPlayers] = useState<Map<string, ClipPlayer>>(new Map());
  // Overlays on the video: the organization's default until changed here (not saved).
  const { orgIncidentOverlay, setOrgIncidentOverlay } = useUiStore();
  const [overlayChoice, setOverlay] = useState<LiveOverlay | null>(null);
  const overlay = overlayChoice ?? orgIncidentOverlay;
  const [playheadMs, setPlayheadMs] = useState<number | null>(null);
  const unlisten = useRef(new Map<string, () => void>());
  const onPlayer = useCallback((cameraId: string, p: ClipPlayer | null) => {
    unlisten.current.get(cameraId)?.();
    unlisten.current.delete(cameraId);
    if (p) {
      const update = () => setPlayheadMs(p.startMs + p.video.currentTime * 1000);
      p.video.addEventListener('timeupdate', update);
      p.video.addEventListener('seeked', update);
      unlisten.current.set(cameraId, () => {
        p.video.removeEventListener('timeupdate', update);
        p.video.removeEventListener('seeked', update);
      });
    }
    setPlayers((prev) => {
      const next = new Map(prev);
      if (p) next.set(cameraId, p); else next.delete(cameraId);
      return next;
    });
  }, []);

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
        description={[`Started ${formatTime(inc.started_at)}`, persons(inc), `incident ${shortId(inc.id)}`].filter(Boolean).join(' · ')}
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
            <div className="row ev-video-head">
              <h2 className="section-title">Video</h2>
              {players.size > 0 && predictions.some((p) => (p.output as { box?: unknown } | null)?.box) && (
                <IncidentOverlayMenu value={overlay} onChange={setOverlay} orgDefault={orgIncidentOverlay}
                  canSetDefault={can(PERM.manageSettings)} onDefaultSaved={setOrgIncidentOverlay} />
              )}
            </div>
            <IncidentVideos inc={inc} onPlayer={onPlayer} overlay={overlay} predictions={predictions} />
          </section>
          <section className="card ev-section">
            <h2 className="section-title">What the detector saw</h2>
            <Timeline predictions={predictions} players={players} playheadMs={playheadMs} />
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
                {respond && <div className="row">
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
                </div>}
              </>
            )}
          </section>
          <section className="card ev-section">
            <h2 className="section-title">History</h2>
            <History inc={inc} activity={activity} />
          </section>
          <section className="card ev-section">
            <h2 className="section-title">Notes ({inc.note_list.length})</h2>
            <Notes incidentId={inc.id} notes={inc.note_list} onAdded={reload} canAdd={respond} />
          </section>
          <section className="card ev-section">
            <h2 className="section-title">Incident reports</h2>
            <IncidentReportsPanel incidentId={inc.id} />
          </section>
          {can(PERM.incidentReports) && (
            <section className="card ev-section">
              <h2 className="section-title">Share video</h2>
              <ShareLinksPanel incidentId={inc.id} />
            </section>
          )}
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
          {respond && alert && (alert.status === 'resolved' || alert.status === 'false_positive') && (
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
