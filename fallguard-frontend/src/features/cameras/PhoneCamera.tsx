import { useEffect, useState, type FormEvent } from 'react';
import QRCode from 'qrcode';
import { api, type PhoneLinks } from '../../services/api/fallguard';

const STREAMZA_ANDROID = 'https://play.google.com/store/apps/details?id=com.streamza.app';
const LARIX_ANDROID = 'https://play.google.com/store/apps/details?id=com.wmspanel.larix_broadcaster';
const LARIX_IOS = 'https://apps.apple.com/app/larix-broadcaster/id1042474385';

function useQr(text: string) {
  const [qr, setQr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(text, { errorCorrectionLevel: 'M', margin: 2, width: 400, color: { dark: '#16191d', light: '#ffffff' } })
      .then((d) => alive && setQr(d))
      .catch(() => alive && setQr(null));
    return () => { alive = false; };
  }, [text]);
  return qr;
}

function useCopy(value: string) {
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
  return { copied, copy };
}

/** One value to put into the phone: a QR code to scan (then "Copy" on the phone) and the text with Copy. */
function QrField({ step, label, value, hint }: { step?: number; label: string; value: string; hint?: string }) {
  const qr = useQr(value);
  const { copied, copy } = useCopy(value);
  return (
    <div className="qr-field">
      <p className="qr-field__label">{step && <span className="qr-field__step">{step}</span>}{label}</p>
      {qr && <img className="qr-field__img" src={qr} alt={`QR code: ${label}`} width={150} height={150} />}
      <code className="qr-field__value">{value}</code>
      <div className="row qr-field__actions">
        <button type="button" className="btn btn--sm" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
      {hint && <p className="muted qr-field__hint">{hint}</p>}
    </div>
  );
}

/** How to connect a phone: shown once, right after a phone camera is added or gets a new QR code. */
export function PhoneSetup({ links, onClose }: { links: PhoneLinks; onClose: () => void }) {
  const plain = links.rtmp_server_url !== '';
  const [more, setMore] = useState(!plain);
  return (
    <section className="card phone-setup" aria-label={`Connect ${links.name}`}>
      <h2 className="section-title">Connect “{links.name}”</h2>
      <p className="notice">Shown only once. Lost it? Use <b>New QR code</b> on the camera (the old one stops working).</p>

      {plain && (
        <div className="phone-setup__block">
          <h3 className="phone-setup__h">With Streamza (Android, free)</h3>
          <ol className="phone-setup__steps">
            <li>Install <a href={STREAMZA_ANDROID} target="_blank" rel="noreferrer"><b>Streamza</b></a> and open it.</li>
            <li>Choose <b>Custom RTMP</b>.</li>
            <li>Scan code <b>1</b> with the phone's camera, tap <b>Copy</b>, and paste it into <b>Server URL</b>. Do the same with code <b>2</b> for <b>Stream key</b>.</li>
            <li>Tap <b>Go Live</b>. The camera turns online here within a few seconds.</li>
          </ol>
          <div className="phone-setup__codes">
            <QrField step={1} label="Server URL" value={links.rtmp_server_url} />
            <QrField step={2} label="Stream key" value={links.stream_key} />
          </div>
          <p className="muted phone-setup__tips">
            Tips: landscape, 720p, phone plugged in and screen on. Streamza sends without encryption, which is fine for
            demos; if the key leaks, make a new QR code.
          </p>
        </div>
      )}

      <button type="button" className="btn btn--sm phone-setup__toggle" onClick={() => setMore(!more)} aria-expanded={more}>
        {more ? 'Hide' : 'Show'} other apps (Larix, OBS: encrypted)
      </button>
      {more && (
        <div className="phone-setup__block">
          <p className="muted" style={{ margin: 0 }}>
            <b>Larix Broadcaster</b> (<a href={LARIX_ANDROID} target="_blank" rel="noreferrer">Android</a> ·{' '}
            <a href={LARIX_IOS} target="_blank" rel="noreferrer">iPhone</a>): scan the Larix code and choose Import. Larix's
            free version adds a watermark. Other apps: use the encrypted server and the same stream key.
          </p>
          <div className="phone-setup__codes">
            <QrField label="Larix: scan to import" value={links.setup_url} />
            <QrField label="Server (encrypted, RTMPS)" value={links.server_url} />
            <QrField label="Stream key" value={links.stream_key} />
          </div>
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
        <label className="field">Name<input required value={name} onChange={(e) => setName(e.target.value)} placeholder="iPhone" /></label>
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
