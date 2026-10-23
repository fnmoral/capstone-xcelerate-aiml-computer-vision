import { useState, type FormEvent } from 'react';
import { PageHeader } from '../../components/ui/PageHeader';
import { EmptyState } from '../../components/ui/EmptyState';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { Icon } from '../../components/ui/Icon';
import { api, type CameraInput } from '../../services/api/fallguard';
import { usePolling } from '../../services/api/usePolling';
import type { Camera } from '../../types/domain';
import './cameras.css';

const EMPTY: CameraInput = { name: '', rtsp_url: '', username: '', password: '', location: '', zone: '' };

function AddCameraForm({ onDone }: { onDone: () => void }) {
  const [form, setForm] = useState<CameraInput>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof CameraInput) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.addCamera(form);
      setForm(EMPTY);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="card cams-form" onSubmit={submit}>
      <h2 className="section-title">Add an IP camera</h2>
      {error && <p className="notice notice--error">{error}</p>}
      <div className="form-grid">
        <label className="field">Name<input required value={form.name} onChange={set('name')} placeholder="Hallway camera" /></label>
        <label className="field">RTSP URL<input required value={form.rtsp_url} onChange={set('rtsp_url')}
          placeholder="rtsp://192.168.1.50:554/stream1" pattern="rtsps?://.+" />
          <small>H.264 stream. For the test camera: rtsp://test-camera:8554/webcam</small></label>
        <label className="field">Username<input value={form.username} onChange={set('username')} autoComplete="off" /></label>
        <label className="field">Password<input type="password" value={form.password} onChange={set('password')} autoComplete="new-password" />
          <small>Stored only on the gateway</small></label>
        <label className="field">Location<input value={form.location} onChange={set('location')} placeholder="2nd floor hallway" />
          <small>Shown on alerts</small></label>
        <label className="field">Zone<input value={form.zone} onChange={set('zone')} list="zone-options" placeholder="Optional" />
          <small>Cameras in one zone see the same area: a fall seen by several is one alert</small></label>
      </div>
      <div className="row cams-form__actions">
        <button className="btn btn--primary" disabled={saving}>{saving ? 'Adding…' : 'Add camera'}</button>
        <button type="button" className="btn" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

function CameraRow({ cam, onChange }: { cam: Camera; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [location, setLocation] = useState(cam.location ?? '');
  const [zone, setZone] = useState(cam.zone ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const paused = cam.status === 'paused';

  return (
    <li className="card cams-row">
      <div className="cams-row__main">
        <div className="cams-row__title">
          <strong>{cam.name}</strong>
          <StatusBadge value={cam.status} />
          {cam.on_gateway && !paused && (cam.live
            ? <StatusBadge value="online" label="Receiving video" />
            : <StatusBadge value="offline" label="No video yet" />)}
          {cam.active_incidents > 0 && <StatusBadge value="active" label={`${cam.active_incidents} active incident(s)`} />}
        </div>
        {editing ? (
          <div className="form-grid cams-row__edit">
            <label className="field">Location<input value={location} onChange={(e) => setLocation(e.target.value)} /></label>
            <label className="field">Zone<input value={zone} onChange={(e) => setZone(e.target.value)} list="zone-options" /></label>
          </div>
        ) : (
          <p className="muted cams-row__info">
            {cam.location || 'No location'} · {cam.zone ? `Zone: ${cam.zone}` : 'No zone'}
            <br /><span className="mono">{cam.rtsp_url || 'Registered in the database only'}</span>
          </p>
        )}
        {error && <p className="notice notice--error">{error}</p>}
      </div>
      <div className="row cams-row__actions">
        {editing ? (
          <>
            <button className="btn btn--primary btn--sm" disabled={busy}
              onClick={() => run(async () => { await api.updateCamera(cam.id, { location, zone }); setEditing(false); })}>Save</button>
            <button className="btn btn--sm" onClick={() => setEditing(false)}>Cancel</button>
          </>
        ) : (
          <button className="btn btn--sm" onClick={() => setEditing(true)}>Edit</button>
        )}
        {cam.on_gateway && (
          <button className="btn btn--sm" disabled={busy}
            title={paused ? 'Start streaming again' : 'Stop streaming without removing the camera'}
            onClick={() => run(() => (paused ? api.resumeCamera(cam.id) : api.pauseCamera(cam.id)))}>
            <Icon name={paused ? 'play' : 'pause'} size={14} /> {paused ? 'Resume' : 'Pause'}
          </button>
        )}
        <button className="btn btn--sm btn--danger" disabled={busy}
          onClick={() => confirm(`Remove "${cam.name}"? Its past incidents are kept.`) && run(() => api.deleteCamera(cam.id))}>
          <Icon name="trash" size={14} /> Remove
        </button>
      </div>
    </li>
  );
}

export default function CamerasPage() {
  const { data, error, loading, reload } = usePolling(() => api.cameras(), 5000);
  const [adding, setAdding] = useState(false);
  const cameras = data?.cameras ?? [];
  const zones = [...new Set(cameras.map((c) => c.zone).filter((z): z is string => Boolean(z)))].sort();
  const onGateway = cameras.filter((c) => c.on_gateway).length;

  return (
    <>
      <PageHeader title="Cameras"
        description={`IP cameras streamed through the gateway (${onGateway} of 3 per gateway). Pausing stops the video without removing the camera.`}
        actions={!adding && (
          <button className="btn btn--primary" disabled={onGateway >= 3} onClick={() => setAdding(true)}>
            <Icon name="plus" size={16} /> {onGateway >= 3 ? 'Gateway full (3)' : 'Add camera'}
          </button>
        )} />
      {error && <p className="notice notice--error">{error}</p>}
      {data?.gateway_error && <p className="notice notice--error">Gateway unavailable: {data.gateway_error}</p>}
      {adding && <AddCameraForm onDone={() => { setAdding(false); void reload(); }} />}
      {loading && !data ? <p className="muted">Loading…</p> : cameras.length === 0 ? (
        <EmptyState icon="camera" title="No cameras yet" body="Add an IP camera's RTSP address to start monitoring." />
      ) : (
        <ul className="cams-list">
          {cameras.map((c) => <CameraRow key={c.id} cam={c} onChange={() => void reload()} />)}
        </ul>
      )}
      {/* Zone suggestions for every zone field on the page */}
      <datalist id="zone-options">{zones.map((z) => <option key={z} value={z} />)}</datalist>
    </>
  );
}
