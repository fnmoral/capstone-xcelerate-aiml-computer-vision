import { useState, type FormEvent } from 'react';
import { ShareLink } from '../../components/ui/ShareLink';
import { api, type PhoneLinks } from '../../services/api/fallguard';

const LARIX_ANDROID = 'https://play.google.com/store/apps/details?id=com.wmspanel.larix_broadcaster';
const LARIX_IOS = 'https://apps.apple.com/app/larix-broadcaster/id1042474385';

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <label className="field phone-setup__field">{label}
      <span className="row">
        <input readOnly value={value} className="mono" onFocus={(e) => e.target.select()} />
        <button type="button" className="btn btn--sm" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</button>
      </span>
    </label>
  );
}

/** How to connect a phone: shown once, right after a phone camera is added or gets a new QR code. */
export function PhoneSetup({ links, onClose }: { links: PhoneLinks; onClose: () => void }) {
  const [manual, setManual] = useState(false);
  return (
    <section className="card phone-setup" aria-label={`Connect ${links.name}`}>
      <h2 className="section-title">Connect “{links.name}”</h2>
      <p className="notice">This QR code and password are shown only once. Lost it? Use <b>New QR code</b> on the camera.</p>
      <ol className="phone-setup__steps">
        <li>On the phone, install <b>Larix Broadcaster</b> (free): <a href={LARIX_ANDROID} target="_blank" rel="noreferrer">Android</a> · <a href={LARIX_IOS} target="_blank" rel="noreferrer">iPhone</a>.</li>
        <li>Scan this QR code with the phone's camera and open it in Larix. The FallGuard connection is added for you.</li>
        <li>In Larix, tap the red button to start streaming. Any Wi-Fi or mobile data works. The camera turns <b>online</b> here within a few seconds.</li>
      </ol>
      <ShareLink url={links.setup_url} label={`Larix setup link for ${links.name}`} fileName={`fallguard-${links.path}`} />
      <p className="muted phone-setup__tips">Tips: keep the phone plugged in and the screen on; landscape, 720p or 1080p, H.264 (Larix's default).</p>
      <button type="button" className="btn btn--sm" onClick={() => setManual(!manual)} aria-expanded={manual}>
        {manual ? 'Hide' : 'Show'} the address for another streaming app
      </button>
      {manual && (
        <div className="phone-setup__manual">
          <CopyField label="Full address (RTMPS)" value={links.publish_url} />
          <p className="muted">Apps that ask for a server and a stream key:</p>
          <CopyField label="Server" value={links.server_url} />
          <CopyField label="Stream key" value={links.stream_key} />
        </div>
      )}
      <div className="row">
        <button type="button" className="btn btn--primary" onClick={onClose}>Done</button>
      </div>
    </section>
  );
}

/** Add a phone that streams to FallGuard from any network (no camera address needed). */
export function AddPhoneCameraForm({ onDone }: { onDone: (links?: PhoneLinks) => void }) {
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [zone, setZone] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      onDone(await api.addPhoneCamera({ name, location, zone }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="card cams-form" onSubmit={submit}>
      <h2 className="section-title">Add a phone camera</h2>
      <p className="muted">A phone with a streaming app sends its video to FallGuard from any Wi-Fi or mobile data. No laptop or camera address needed.</p>
      {error && <p className="notice notice--error">{error}</p>}
      <div className="form-grid">
        <label className="field">Name<input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Berkin's phone" /></label>
        <label className="field">Location<input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Lobby" />
          <small>Shown on alerts</small></label>
        <label className="field">Zone<input value={zone} onChange={(e) => setZone(e.target.value)} list="zone-options" placeholder="Optional" />
          <small>Cameras in one zone see the same area: a fall seen by several is one alert</small></label>
      </div>
      <div className="row cams-form__actions">
        <button className="btn btn--primary" disabled={saving}>{saving ? 'Adding…' : 'Add and show QR code'}</button>
        <button type="button" className="btn" onClick={() => onDone()}>Cancel</button>
      </div>
    </form>
  );
}
