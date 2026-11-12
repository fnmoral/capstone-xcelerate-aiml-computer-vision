import { useState } from 'react';
import { api } from '../../services/api/fallguard';
import type { DetectionSettings } from '../../types/domain';

const DEFAULT = '';  // the select's value for "config.yaml's"

/** Which pose model file and which device (GPU / CPU) the cameras run. ml-service loads a new
 *  choice within 15 seconds; if it can't, it keeps the model that runs and says why. */
export function ModelDevice({ d, onSaved }: { d: DetectionSettings; onSaved: () => unknown }) {
  const [model, setModel] = useState(d.saved.model ?? DEFAULT);
  const [device, setDevice] = useState(d.saved.device ?? DEFAULT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const models = d.models_available ?? [];
  const devices = d.devices_available ?? [];
  const changed = model !== (d.saved.model ?? DEFAULT) || device !== (d.saved.device ?? DEFAULT);

  const save = async (m: string, dev: string) => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await api.saveDetectionChange(d.saved, { model: m || null, device: dev || null });
      setModel(m);
      setDevice(dev);
      setDone('Saved. The cameras switch within 15 seconds (tracking restarts for a moment).');
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const deviceLabel = (v: string) => devices.find((x) => x.value === v)?.label ?? v;
  const wantModel = d.saved.model ?? d.model_default;
  const applying = !d.inference_error && d.device_in_use != null && wantModel !== d.model;

  return (
    <section className="card" style={{ padding: 16 }}>
      <h2 className="section-title">Model and device</h2>
      <p className="muted" style={{ marginTop: 0, maxWidth: '75ch' }}>
        The pose model finds people and their body points; the fall rules then decide. The fine-tuned model was trained
        on fall videos. A GPU is several times faster than the CPU: on the CPU fewer frames per second are checked.
      </p>
      {error && <p className="notice notice--error">{error}</p>}
      {d.inference_error && <p className="notice notice--error">Not applied: {d.inference_error}. The cameras keep running {d.model}.</p>}
      {done && <p className="notice">{done}</p>}
      <div className="row" style={{ gap: 16, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <label className="field" style={{ minWidth: 260 }}>Model
          <select value={model} onChange={(e) => setModel(e.target.value)} disabled={busy || models.length === 0}>
            <option value={DEFAULT}>Default ({d.model_default})</option>
            {models.filter((m) => m !== d.model_default).map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label className="field" style={{ minWidth: 260 }}>Device
          <select value={device} onChange={(e) => setDevice(e.target.value)} disabled={busy || devices.length === 0}>
            <option value={DEFAULT}>Default ({deviceLabel(d.device)})</option>
            {devices.filter((x) => x.value !== d.device).map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
          </select>
        </label>
        <button className="btn btn--primary" disabled={busy || !changed} onClick={() => save(model, device)}>Save</button>
        <button className="btn" disabled={busy || (d.saved.model === undefined && d.saved.device === undefined)}
          onClick={() => save(DEFAULT, DEFAULT)}>Back to default</button>
      </div>
      <p className="muted" style={{ marginBottom: 0, fontSize: 13 }}>
        In use now: <strong>{d.model}</strong> on <strong>{d.device_in_use ?? '—'}</strong>
        {applying ? ' · applying the saved choice…' : ''}
        {models.length === 0 && ' · this ml-service version does not list its models yet'}
      </p>
    </section>
  );
}
