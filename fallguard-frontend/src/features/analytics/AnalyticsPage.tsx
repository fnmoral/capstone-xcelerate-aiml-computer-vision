import { PageHeader } from '../../components/ui/PageHeader';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { api } from '../../services/api/fallguard';
import { usePolling } from '../../services/api/usePolling';
import { formatDuration, shortId } from '../../lib/format';
import { DailyChart } from './DailyChart';
import './analytics.css';

function Breakdown({ title, counts, order }: { title: string; counts: Record<string, number>; order: string[] }) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return (
    <section className="card an-section">
      <h2 className="section-title">{title}</h2>
      {total === 0 ? <p className="muted">No data yet.</p> : (
        <ul className="an-list">
          {order.filter((k) => counts[k]).map((k) => (
            <li key={k}><StatusBadge value={k} /><span className="an-count">{counts[k]}</span></li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function AnalyticsPage() {
  const { data: s, error } = usePolling(() => api.stats(), 10000);

  return (
    <>
      <PageHeader title="Analytics" description="How many falls, how long people were down, and where they happen. False alarms are excluded." />
      {error && <p className="notice notice--error">{error}</p>}
      {!s ? <p className="muted">Loading…</p> : (
        <>
          <div className="tiles">
            <div className="tile card"><div className="tile__label">Active now</div><div className="tile__value">{s.active_incidents}</div>
              <div className="tile__hint">people still on the floor</div></div>
            <div className="tile card"><div className="tile__label">Open alerts</div><div className="tile__value">{s.open_alerts}</div>
              <div className="tile__hint">not yet acknowledged</div></div>
            <div className="tile card"><div className="tile__label">Falls today</div><div className="tile__value">{s.incidents_today}</div></div>
            <div className="tile card"><div className="tile__label">Falls, last 7 days</div><div className="tile__value">{s.incidents_7d}</div>
              <div className="tile__hint">{s.false_positives_7d} false alarm(s) excluded</div></div>
            <div className="tile card"><div className="tile__label">Average time down</div>
              <div className="tile__value">{formatDuration(s.avg_down_seconds_7d)}</div><div className="tile__hint">last 7 days</div></div>
          </div>

          <section className="card an-section">
            <h2 className="section-title">Falls per day</h2>
            <DailyChart days={s.per_day} />
          </section>

          <div className="an-grid">
            <section className="card an-section">
              <h2 className="section-title">Falls by camera (30 days)</h2>
              {s.per_camera.length === 0 ? <p className="muted">No falls recorded.</p> : (
                <ul className="an-bars">
                  {s.per_camera.map((c) => (
                    <li key={c.camera_id}>
                      <span className="an-bars__name">{c.camera_name ?? shortId(c.camera_id)}</span>
                      <span className="an-bars__track">
                        <span className="an-bars__fill" style={{ width: `${(c.count / s.per_camera[0].count) * 100}%` }} />
                      </span>
                      <span className="an-count">{c.count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <Breakdown title="Outcome (30 days)" counts={s.by_status} order={['active', 'unresolved', 'recovered', 'false_positive']} />
            <Breakdown title="Severity (30 days)" counts={s.by_severity} order={['critical', 'high', 'medium', 'low']} />
            <Breakdown title="Detector labels, last hour" counts={s.predictions_last_hour} order={['lying', 'falling', 'upright']} />
          </div>
        </>
      )}
    </>
  );
}
