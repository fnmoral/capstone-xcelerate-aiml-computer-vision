import { useState } from 'react';
import { api } from '../../services/api/fallguard';
import type { DetectionSettings } from '../../types/domain';

/** The one setting tuned here: how sure the detector must be that something is a person. */
export function PersonConfidence({ d, onSaved }: { d: DetectionSettings; onSaved: () => unknown }) {
  const saved = d.saved.person_confidence;
  const [value, setValue] = useState<number>(saved ?? d.person_confidence);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const save = async (v: number | null) => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await api.saveDetection({ person_confidence: v });
      setDone(v === null ? 'Back to the default. Applied within 15 seconds.' : 'Saved. Applied within 15 seconds.');
      if (v === null) setValue(d.person_confidence_default);
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const pending = saved !== undefined && Math.abs(saved - d.person_confidence) > 1e-6;
  return (
    <section className="card" style={{ padding: 16 }}>
      <h2 className="section-title">Minimum person confidence</h2>
      <p className="muted" style={{ marginTop: 0, maxWidth: '75ch' }}>
        How sure the detector must be that something is a person before it is tracked. Raise it if objects such as
        plush toys, pillows or coats cause false alarms; lower it if people who are partly hidden (under a blanket,
        behind furniture) are missed. Default {d.person_confidence_default}.
      </p>
      {error && <p className="notice notice--error">{error}</p>}
      {done && <p className="notice">{done}</p>}
      <div className="row" style={{ gap: 16 }}>
        <input type="range" min={0.1} max={0.9} step={0.05} value={value} aria-label="Minimum person confidence"
          onChange={(e) => setValue(Number(e.target.value))} style={{ width: 260 }} />
        <strong style={{ fontVariantNumeric: 'tabular-nums', minWidth: 40 }}>{value.toFixed(2)}</strong>
        <button className="btn btn--primary" disabled={busy || Math.abs(value - (saved ?? d.person_confidence)) < 1e-6}
          onClick={() => save(value)}>Save</button>
        <button className="btn" disabled={busy || saved === undefined} onClick={() => save(null)}>Back to default</button>
      </div>
      <p className="muted" style={{ marginBottom: 0, fontSize: 13 }}>
        In use now: <strong>{d.person_confidence}</strong>
        {pending ? ` · saved ${saved}, applying…` : saved !== undefined ? ' (set here)' : ' (default from config.yaml)'}
      </p>
    </section>
  );
}
