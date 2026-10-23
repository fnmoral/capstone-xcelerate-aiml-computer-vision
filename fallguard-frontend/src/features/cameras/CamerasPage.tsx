import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../../components/ui/PageHeader';
import { EmptyState } from '../../components/ui/EmptyState';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { Icon } from '../../components/ui/Icon';
import { api, type CameraInput } from '../../services/api/fallguard';
import { usePolling } from '../../services/api/usePolling';
import type { Camera } from '../../types/domain';
import { formatTime } from '../../lib/format';
import { CameraOrder } from './CameraOrder';
import './cameras.css';

const EMPTY: CameraInput = { name: '', rtsp_url: '', username: '', password: '', location: '', zone: '', alert_offline: true };

function AddCameraForm({ onDone, standby }: { onDone: (status?: string) => void; standby: string | null }) {
  const [form, setForm] = useState<CameraInput>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof CameraInput) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const added = await api.addCamera(form);
      setForm(EMPTY);
      onDone(added.status);
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
      <label className="switch cams-form__switch">
        <input type="checkbox" checked={form.alert_offline}
          onChange={(e) => setForm({ ...form, alert_offline: e.target.checked })} />
        Alert me if this camera stops working
      </label>
      {standby && <p className="notice cams-form__standby">{standby}</p>}
      <div className="row cams-form__actions">
        <button className="btn btn--primary" disabled={saving}>{saving ? 'Adding…' : 'Add camera'}</button>
        <button type="button" className="btn" onClick={() => onDone()}>Cancel</button>
      </div>
    </form>
  );
}

/** Paused camera on a gateway at its streaming limit: pick which streaming camera to stop. */
function SwitchTo({ cam, streaming, busy, run }: {
  cam: Camera; streaming: Camera[]; busy: boolean; run: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [replace, setReplace] = useState(streaming[0]?.id ?? '');
  if (!open) {
    return (
      <button className="btn btn--sm btn--primary" disabled={busy || streaming.length === 0} onClick={() => setOpen(true)}
        title="All streaming slots are in use: stop one of them and stream this camera instead">
        <Icon name="play" size={14} /> Switch to this
      </button>
    );
  }
  return (
    <span className="cams-switch">
      <label>Stop
        <select value={replace} onChange={(e) => setReplace(e.target.value)} aria-label="Camera to stop streaming">
          {streaming.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </label>
      <button className="btn btn--sm btn--primary" disabled={busy || !replace}
        onClick={() => run(async () => { await api.switchCamera(cam.id, replace); setOpen(false); })}>Switch</button>
      <button className="btn btn--sm" onClick={() => setOpen(false)}>Cancel</button>
    </span>
  );
}

function CameraRow({ cam, onChange, full, streaming }: {
  cam: Camera; onChange: () => void; full: boolean; streaming: Camera[];
}) {
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
          <StatusBadge value={cam.health} />
          <span className="muted cams-row__since">since {formatTime(cam.health_since)}</span>
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
        {cam.on_gateway && (
          <label className="switch">
            <input type="checkbox" checked={cam.alert_offline} disabled={busy}
              onChange={(e) => run(() => api.updateCamera(cam.id, { alert_offline: e.target.checked }))} />
            Alert me if it stops working
          </label>
        )}
        {error && <p className="notice notice--error">{error}</p>}
      </div>
      <div className="row cams-row__actions">
        <Link className="btn btn--sm" to={`/camera-logs?camera=${encodeURIComponent(cam.id)}`}>
          <Icon name="log" size={14} /> Log
        </Link>
        {editing ? (
          <>
            <button className="btn btn--primary btn--sm" disabled={busy}
              onClick={() => run(async () => { await api.updateCamera(cam.id, { location, zone }); setEditing(false); })}>Save</button>
            <button className="btn btn--sm" onClick={() => setEditing(false)}>Cancel</button>
          </>
        ) : (
          <button className="btn btn--sm" onClick={() => setEditing(true)}>Edit</button>
        )}
        {cam.on_gateway && (paused && full ? (
          <SwitchTo cam={cam} streaming={streaming} busy={busy} run={run} />
        ) : (
          <button className="btn btn--sm" disabled={busy}
            title={paused ? 'Start streaming again' : 'Stop streaming without removing the camera (it stays saved, on standby)'}
            onClick={() => run(() => (paused ? api.resumeCamera(cam.id) : api.pauseCamera(cam.id)))}>
            <Icon name={paused ? 'play' : 'pause'} size={14} /> {paused ? 'Resume' : 'Pause'}
          </button>
        ))}
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
  const [notice, setNotice] = useState<string | null>(null);
  const onGateway = cameras.filter((c) => c.on_gateway);
  const streaming = onGateway.filter((c) => c.status !== 'paused');
  const maxStreaming = data?.limits?.max_streaming ?? 5;
  const maxSaved = data?.limits?.max_saved ?? 50;
  const full = streaming.length >= maxStreaming;

  return (
    <>
      <PageHeader title="Cameras"
        description={`Streaming ${streaming.length} of ${maxStreaming} at a time · ${onGateway.length - streaming.length} paused (standby) · `
          + `${onGateway.length} of ${maxSaved} saved. A paused camera keeps its address and login, so you can switch `
          + 'which cameras stream without removing and adding them again.'}
        actions={!adding && (
          <button className="btn btn--primary" disabled={onGateway.length >= maxSaved} onClick={() => setAdding(true)}>
            <Icon name="plus" size={16} /> {onGateway.length >= maxSaved ? `Gateway full (${maxSaved})` : 'Add camera'}
          </button>
        )} />
      {error && <p className="notice notice--error">{error}</p>}
      {data?.gateway_error && <p className="notice notice--error">Gateway unavailable: {data.gateway_error}</p>}
      {notice && <p className="notice" role="status">{notice}</p>}
      {adding && (
        <AddCameraForm
          standby={full ? `${streaming.length} cameras are already streaming, the most at once: this one will be saved paused (standby). Use "Switch to this" to stream it instead of another.` : null}
          onDone={(status) => {
            setAdding(false);
            setNotice(status === 'paused' ? 'Camera saved on standby (paused). Use "Switch to this" on it to stream it instead of another camera.' : null);
            void reload();
          }} />
      )}
      {cameras.length > 1 && <CameraOrder cameras={cameras} onSaved={reload} />}
      {loading && !data ? <p className="muted">Loading…</p> : cameras.length === 0 ? (
        <EmptyState icon="camera" title="No cameras yet" body="Add an IP camera's RTSP address to start monitoring." />
      ) : (
        <ul className="cams-list">
          {cameras.map((c) => (
            <CameraRow key={c.id} cam={c} onChange={() => void reload()} full={full} streaming={streaming} />
          ))}
        </ul>
      )}
      {/* Zone suggestions for every zone field on the page */}
      <datalist id="zone-options">{zones.map((z) => <option key={z} value={z} />)}</datalist>
    </>
  );
}
