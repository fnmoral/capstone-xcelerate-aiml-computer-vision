import { useEffect, useState } from 'react';
import { api } from '../../services/api/fallguard';
import { browserTimeZone } from '../../lib/format';
import { useUiStore } from '../../store/uiStore';

const ZONES: string[] = Intl.supportedValuesOf('timeZone');

const now = (timeZone: string) =>
  new Date().toLocaleString([], { timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Facility-wide time zone: times in the app, falls per day, reports and CSV exports. */
export function TimeZoneSettings() {
  const { timeZone, setTimeZone } = useUiStore();
  const [value, setValue] = useState(timeZone ?? '');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [, tick] = useState(0);

  useEffect(() => setValue(timeZone ?? ''), [timeZone]);
  useEffect(() => { // keep the preview clock current
    const t = window.setInterval(() => tick((n) => n + 1), 30000);
    return () => window.clearInterval(t);
  }, []);

  const save = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const tz = value || null;
      await api.saveSettings({ timezone: tz });
      setTimeZone(tz);
      setStatus('Saved. Applies to everyone using FallGuard.');
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const shown = value || browserTimeZone;
  return (
    <section className="card" style={{ padding: 20 }}>
      <h2 className="section-title">Time zone</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Used for every time in the app, the falls-per-day chart and "today", report time windows and CSV exports.
        Set the facility's zone so everyone sees the same times; otherwise each browser uses its own.
      </p>
      {status && <p className="notice" role="status">{status}</p>}
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <label className="field" style={{ minWidth: 280 }}>Time zone
          <select value={value} onChange={(e) => setValue(e.target.value)}>
            <option value="">This browser's time zone ({browserTimeZone})</option>
            {ZONES.map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
          </select>
        </label>
        <button className="btn btn--primary" disabled={busy || value === (timeZone ?? '')} onClick={save}>Save</button>
      </div>
      <p className="muted" style={{ marginBottom: 0, fontSize: 13 }}>
        Now in {shown.replace(/_/g, ' ')}: <strong>{now(shown)}</strong>
      </p>
    </section>
  );
}
