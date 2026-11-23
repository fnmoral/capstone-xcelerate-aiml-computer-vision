import { useEffect, useState, type FormEvent } from 'react';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { api } from '../../services/api/fallguard';
import { usePolling } from '../../services/api/usePolling';
import { formatTime } from '../../lib/format';
import type { Gateway, GatewayConfig } from '../../types/domain';
import './gateways.css';

const KIND: Record<Gateway['kind'], string> = { cloud: 'Cloud', onsite: 'On-site' };
const KIND_HINT: Record<Gateway['kind'], string> = {
  cloud: 'On the server: phone cameras only',
  onsite: 'Next to the cameras: IP cameras and webcams',
};

type Msg = { ok: boolean; text: string } | null;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Name and location of a gateway. */
function EditForm({ g, onSaved, onCancel }: { g: Gateway; onSaved: (text: string) => void; onCancel: () => void }) {
  const [name, setName] = useState(g.name);
  const [location, setLocation] = useState(g.location ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.updateGateway(g.id, { name, location });
      onSaved(`Saved: ${name}.`);
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  };
  return (
    <form onSubmit={save} className="gw-panel">
      <div className="form-grid">
        <label className="field">Name
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} placeholder="e.g. Office server" />
          <small>The place it runs, shown on the Cameras page</small>
        </label>
        <label className="field">Location (optional)
          <input value={location} onChange={(e) => setLocation(e.target.value)} maxLength={120} placeholder="e.g. 2nd floor, front desk" />
        </label>
      </div>
      {error && <p className="notice notice--error">{error}</p>}
      <div className="row">
        <button className="btn btn--primary btn--sm" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" className="btn btn--sm" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

/** Where the gateway sends video (its own settings; saving re-registers it). */
function ConnectionForm({ g, onSaved, onCancel }: { g: Gateway; onSaved: (text: string) => void; onCancel: () => void }) {
  const [cfg, setCfg] = useState<GatewayConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.gatewayConfig(g.id).then(setCfg).catch((e) => setError(errText(e))); }, [g.id]);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!cfg) return;
    setBusy(true);
    try {
      await api.saveGatewayConfig(g.id, {
        stream_hub_address: cfg.stream_hub_address.trim(), back_end_address: cfg.back_end_address,
        tenant_name: cfg.tenant_name, gateway_name_id: cfg.gateway_name_id,
      });
      onSaved(`${g.name}: connection saved. Cameras pick up the new address when they reconnect.`);
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  };
  return (
    <form onSubmit={save} className="gw-panel">
      {!cfg && !error && <p className="muted">Loading…</p>}
      {cfg && (
        <>
          <label className="field">Stream hub address
            <input value={cfg.stream_hub_address} onChange={(e) => setCfg({ ...cfg, stream_hub_address: e.target.value })} required />
            <small>Where this gateway sends video, host:port</small>
          </label>
          <p className="muted gw-meta">Gateway ID <span className="mono">{cfg.gateway_name_id}</span> · main system <span className="mono">{cfg.back_end_address}</span></p>
        </>
      )}
      {error && <p className="notice notice--error">{error}</p>}
      <div className="row">
        {cfg && <button className="btn btn--primary btn--sm" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>}
        <button type="button" className="btn btn--sm" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

/** Forget a gateway, optionally with its cameras. */
function RemoveForm({ g, onDone, onCancel }: { g: Gateway; onDone: (text: string) => void; onCancel: () => void }) {
  const [withCameras, setWithCameras] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    setBusy(true);
    try {
      const r = await api.deleteGateway(g.id, withCameras);
      onDone(`${g.name} removed${r.cameras_removed ? `, with ${r.cameras_removed} camera(s)` : ''}.`);
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  };
  return (
    <div className="gw-panel gw-panel--danger">
      <p style={{ margin: 0 }}>Remove <strong>{g.name}</strong>? If it starts again it signs up as a new gateway.</p>
      {g.cameras > 0 && (
        <label className="check">
          <input type="checkbox" checked={withCameras} onChange={(e) => setWithCameras(e.target.checked)} />
          Also remove its {g.cameras} camera{g.cameras === 1 ? '' : 's'} (their incidents stay in the history)
        </label>
      )}
      {g.cameras > 0 && !withCameras && <p className="muted gw-meta">Otherwise its cameras stay listed, on no gateway.</p>}
      {error && <p className="notice notice--error">{error}</p>}
      <div className="row">
        <button className="btn btn--danger btn--sm" disabled={busy} onClick={() => void remove()}>{busy ? 'Removing…' : 'Remove gateway'}</button>
        <button className="btn btn--sm" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

type Panel = { id: string; kind: 'edit' | 'connection' | 'remove' } | null;

/** Settings → Gateways: which gateway the app uses (one at a time), and each gateway's
 *  name, location, connection and removal. */
export function GatewaysSettings() {
  const { data, error, reload } = usePolling(() => api.gateways(), 15000);
  const [panel, setPanel] = useState<Panel>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const gateways = data?.gateways ?? [];
  const inUse = gateways.find((g) => g.in_use);

  const choose = async (id: string | null) => {
    setBusy(true);
    setMsg(null);
    try {
      const st = await api.setGateway(id);
      const now = st.gateways.find((g) => g.in_use);
      setMsg({ ok: true, text: id ? `Now using ${now?.name ?? 'that gateway'}.` : `Automatic: using ${now?.name ?? 'no gateway yet'}.` });
      await reload();
    } catch (err) {
      setMsg({ ok: false, text: errText(err) });
    } finally {
      setBusy(false);
    }
  };
  const done = async (text: string) => {
    setPanel(null);
    setMsg({ ok: true, text });
    await reload();
  };

  return (
    <section className="card" style={{ padding: 20 }}>
      <h2 className="section-title">Gateways</h2>
      <p className="muted" style={{ marginTop: -6 }}>
        A gateway connects cameras to FallGuard. On-site gateways run next to the cameras; the cloud gateway runs on the
        server and takes phone cameras only. The app uses one gateway at a time.
      </p>
      {error && <p className="notice notice--error">{error}</p>}
      {msg && <p className={`notice${msg.ok ? '' : ' notice--error'}`} role="status">{msg.text}</p>}
      {data && (
        <label className="field gw-mode">Gateway in use
          <select value={data.mode === 'chosen' && data.in_use ? data.in_use : ''} disabled={busy}
            onChange={(e) => void choose(e.target.value || null)}>
            <option value="">Automatic: on-site when one is online, else cloud</option>
            {gateways.map((g) => (
              <option key={g.id} value={g.id}>{g.name}{g.location ? ` (${g.location})` : ''} · {KIND[g.kind]}{g.online ? '' : ' · offline'}</option>
            ))}
          </select>
          <small>
            {inUse ? <>Using <strong>{inUse.name}</strong>{inUse.online ? '' : ' (offline: its cameras are disconnected until it is back)'}.</> : 'No gateway has signed up yet.'}
            {data.mode === 'chosen' && ' Chosen by an admin: kept even while offline.'}
          </small>
        </label>
      )}
      {data && gateways.length === 0 && <p className="muted">No gateways yet. A gateway appears here when it starts and signs up.</p>}
      <ul className="gw-list">
        {gateways.map((g) => {
          const open = panel?.id === g.id ? panel.kind : null;
          return (
            <li key={g.id} className={`gw-item${g.in_use ? ' gw-item--in-use' : ''}`}>
              <div className="gw-item__head">
                <div>
                  <strong>{g.name}</strong>
                  {g.location && <span className="muted"> · {g.location}</span>}
                  <div className="gw-badges">
                    <span className="badge" title={KIND_HINT[g.kind]}>{KIND[g.kind]}</span>
                    <StatusBadge value={g.online ? 'online' : 'offline'} label={g.online ? 'Online' : 'Offline'} />
                    {g.in_use && <StatusBadge value="resolved" label="In use" />}
                  </div>
                  <p className="muted gw-meta">
                    {g.cameras} camera{g.cameras === 1 ? '' : 's'} · {g.online ? 'answering now' : `last seen ${g.last_seen_at ? formatTime(g.last_seen_at) : 'never'}`} · {KIND_HINT[g.kind]}
                  </p>
                </div>
                <div className="row gw-actions">
                  {!(g.in_use && data?.mode === 'chosen') && (
                    <button className="btn btn--sm" disabled={busy} onClick={() => void choose(g.id)}>Use this gateway</button>
                  )}
                  <button className="btn btn--sm" onClick={() => setPanel(open === 'edit' ? null : { id: g.id, kind: 'edit' })}>Edit name and location</button>
                  <button className="btn btn--sm" disabled={!g.online} title={g.online ? undefined : 'The gateway must be online'}
                    onClick={() => setPanel(open === 'connection' ? null : { id: g.id, kind: 'connection' })}>Connection</button>
                  <button className="btn btn--sm btn--danger" disabled={g.in_use}
                    title={g.in_use ? 'In use: choose another gateway (or automatic) first' : undefined}
                    onClick={() => setPanel(open === 'remove' ? null : { id: g.id, kind: 'remove' })}>Remove</button>
                </div>
              </div>
              {open === 'edit' && <EditForm g={g} onSaved={(t) => void done(t)} onCancel={() => setPanel(null)} />}
              {open === 'connection' && <ConnectionForm g={g} onSaved={(t) => void done(t)} onCancel={() => setPanel(null)} />}
              {open === 'remove' && <RemoveForm g={g} onDone={(t) => void done(t)} onCancel={() => setPanel(null)} />}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
