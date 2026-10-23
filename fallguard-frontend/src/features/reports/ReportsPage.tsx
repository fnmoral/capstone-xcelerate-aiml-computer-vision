import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../../components/ui/PageHeader';
import { EmptyState } from '../../components/ui/EmptyState';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { Icon } from '../../components/ui/Icon';
import { DEFAULT_WINDOW, resolveWindow, TimeWindow, type TimeWindowValue } from '../../components/ui/TimeWindow';
import { api, exportUrl, type IncidentQuery, type LogQuery } from '../../services/api/fallguard';
import { usePolling } from '../../services/api/usePolling';
import { alertBy, formatDuration, formatTime } from '../../lib/format';
import type { Incident } from '../../types/domain';
import './reports.css';

const PREVIEW_ROWS = 50;
const MAX_ROWS = 2000;

interface Filters {
  status: string;
  severity: string;
  where: string; // '' | 'zone:<name>' | 'camera:<id>'
  alert: string;
}

const NO_FILTERS: Filters = { status: '', severity: '', where: '', alert: '' };

function incidentQuery(f: Filters, range: TimeWindowValue): IncidentQuery {
  const [kind, value] = f.where.split(/:(.*)/s);
  return {
    status: f.status, severity: f.severity, alert_status: f.alert,
    zone: kind === 'zone' ? value : undefined,
    camera_id: kind === 'camera' ? value : undefined,
    ...resolveWindow(range),
  };
}

function handledBy(i: Incident): string {
  const a = i.alert;
  if (!a) return '—';
  if (a.closed_at) return alertBy(a.closed_by, a.closed_at);
  if (a.acknowledged_at) return alertBy(a.acknowledged_by, a.acknowledged_at);
  return 'Not yet';
}

export default function ReportsPage() {
  const [range, setRange] = useState<TimeWindowValue>(DEFAULT_WINDOW);
  const [f, setF] = useState<Filters>(NO_FILTERS);
  const [logKind, setLogKind] = useState<NonNullable<LogQuery['kind']>>('');
  const set = (k: keyof Filters) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const cams = usePolling(() => api.cameras(), 30000);
  const key = JSON.stringify([f, range]);
  const list = usePolling(() => api.incidents({ ...incidentQuery(f, range), limit: MAX_ROWS }), 15000, [key]);
  const cameras = cams.data?.cameras ?? [];
  const zones = [...new Set(cameras.map((c) => c.zone).filter((z): z is string => Boolean(z)))].sort();
  const incidents = list.data?.incidents ?? [];

  const real = incidents.filter((i) => i.status !== 'false_positive');
  const downTimes = real.map((i) => i.duration_seconds).filter((d): d is number => d !== null);
  const avgDown = downTimes.length ? downTimes.reduce((a, b) => a + b, 0) / downTimes.length : null;
  const unhandled = incidents.filter((i) => i.alert?.status === 'open').length;

  const cameraId = f.where.startsWith('camera:') ? f.where.slice(7) : '';
  const logQuery: LogQuery = { kind: logKind, camera_id: cameraId, ...resolveWindow(range) };

  return (
    <>
      <PageHeader title="Reports & Export"
        description="Pick a time window and filters, check the preview, then download as CSV (opens in Excel or Google Sheets)." />

      <section className="card filters" aria-label="Report filters">
        <TimeWindow value={range} onChange={setRange} />
        <label className="field">Status
          <select value={f.status} onChange={set('status')}>
            <option value="">Any status</option>
            <option value="active">Active (still down)</option>
            <option value="recovered">Recovered</option>
            <option value="unresolved">Unresolved</option>
            <option value="false_positive">False alarm</option>
          </select>
        </label>
        <label className="field">Severity
          <select value={f.severity} onChange={set('severity')}>
            <option value="">Any severity</option>
            {['critical', 'high', 'medium', 'low'].map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
          </select>
        </label>
        <label className="field">Where
          <select value={f.where} onChange={set('where')}>
            <option value="">Everywhere</option>
            {zones.length > 0 && (
              <optgroup label="Zones">{zones.map((z) => <option key={z} value={'zone:' + z}>{z}</option>)}</optgroup>
            )}
            <optgroup label="Cameras">{cameras.map((c) => <option key={c.id} value={'camera:' + c.id}>{c.name}</option>)}</optgroup>
          </select>
        </label>
        <label className="field">Alert
          <select value={f.alert} onChange={set('alert')}>
            <option value="">Any alert status</option>
            <option value="open">Open (not acknowledged)</option>
            <option value="acknowledged">Acknowledged</option>
            <option value="resolved">Resolved</option>
            <option value="false_positive">False alarm</option>
            <option value="none">No alert</option>
          </select>
        </label>
        {(f !== NO_FILTERS || range !== DEFAULT_WINDOW) && (
          <button className="btn btn--sm" onClick={() => { setF(NO_FILTERS); setRange(DEFAULT_WINDOW); }}>Clear filters</button>
        )}
      </section>

      <div className="tiles">
        <div className="tile card"><div className="tile__label">Incidents</div>
          <div className="tile__value">{list.data ? incidents.length : '—'}{incidents.length >= MAX_ROWS ? '+' : ''}</div>
          <div className="tile__hint">{incidents.length - real.length} false alarm(s)</div></div>
        <div className="tile card"><div className="tile__label">Alerts not acknowledged</div>
          <div className="tile__value">{list.data ? unhandled : '—'}</div></div>
        <div className="tile card"><div className="tile__label">Average time down</div>
          <div className="tile__value">{formatDuration(avgDown)}</div>
          <div className="tile__hint">excluding false alarms</div></div>
      </div>

      <section className="card rp-section">
        <div className="rp-head">
          <h2 className="section-title">Incident report</h2>
          <a className="btn btn--primary" href={exportUrl.incidents(incidentQuery(f, range))} download>
            <Icon name="download" size={16} /> Download incidents (CSV)
          </a>
        </div>
        <p className="muted rp-note">
          One row per fall: when, where, how long the person was down, status, severity, and who acknowledged and closed
          the alert, and when.
        </p>
        {list.error && <p className="notice notice--error">{list.error}</p>}
        {list.loading && !list.data ? <p className="muted">Loading…</p> : incidents.length === 0 ? (
          <EmptyState icon="alert" title="No incidents match" body="Widen the time window or clear a filter." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Started</th><th>Where</th><th>Status</th><th>Severity</th><th className="num">Down for</th><th>Alert</th><th>Handled by</th></tr>
              </thead>
              <tbody>
                {incidents.slice(0, PREVIEW_ROWS).map((i) => (
                  <tr key={i.id}>
                    <td><Link to={`/events/${i.id}`}>{formatTime(i.started_at)}</Link></td>
                    <td>{i.location_label ?? i.camera_name ?? 'Unknown camera'}{i.zone && <div className="muted rp-sub">Zone: {i.zone}</div>}</td>
                    <td><StatusBadge value={i.status} /></td>
                    <td><StatusBadge value={i.severity} /></td>
                    <td className="num">{formatDuration(i.duration_seconds)}</td>
                    <td>{i.alert ? <StatusBadge value={i.alert.status} /> : <span className="muted">—</span>}</td>
                    <td className="rp-sub">{handledBy(i)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {incidents.length > PREVIEW_ROWS && (
              <p className="muted rp-sub">Preview shows the first {PREVIEW_ROWS} of {incidents.length}. The download has all of them.</p>
            )}
          </div>
        )}
      </section>

      <section className="card rp-section">
        <div className="rp-head">
          <h2 className="section-title">Activity log</h2>
          <a className="btn" href={exportUrl.logs(logQuery)} download>
            <Icon name="download" size={16} /> Download activity log (CSV)
          </a>
        </div>
        <p className="muted rp-note">
          Everything that happened in the same time window: alerts acknowledged, resolved or marked false alarm, incident
          notes and status changes, and camera changes (added, paused, not working, back online, removed), with who did
          it. {cameraId && 'Only for the selected camera.'}
        </p>
        <div className="tabs" role="group" aria-label="What to include">
          {([['', 'Everything'], ['alert', 'Alerts'], ['incident', 'Incidents'], ['camera', 'Cameras']] as const).map(([v, label]) => (
            <button key={v} className="tab" aria-pressed={logKind === v} onClick={() => setLogKind(v)}>{label}</button>
          ))}
        </div>
      </section>
    </>
  );
}
