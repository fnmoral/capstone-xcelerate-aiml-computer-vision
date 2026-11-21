import { useEffect, useState, type FormEvent } from 'react';
import { PageHeader } from '../../components/ui/PageHeader';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { useUiStore, type LiveLayout, type Theme } from '../../store/uiStore';
import { TimeZoneSettings } from './TimeZoneSettings';
import { OrgProfileSettings } from './OrgProfileSettings';
import { EmailsSentSettings } from './EmailsSentSettings';
import { PERM, useAuth } from '../auth/AuthContext';
import { api } from '../../services/api/fallguard';
import { usePolling } from '../../services/api/usePolling';
import type { GatewayConfig } from '../../types/domain';

const THEMES: Theme[] = ['light', 'dark', 'system'];
const THEME_LABEL: Record<Theme, string> = { light: 'Light', dark: 'Dark', system: 'Same as this device' };

/** Theme: this browser's choice (or the organization's default), and the default itself. */
function ThemeSettings({ manage }: { manage: boolean }) {
  const { theme, orgTheme, setTheme, setOrgTheme } = useUiStore();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const orgLabel = THEME_LABEL[orgTheme ?? 'light'];
  const saveOrg = async (t: Theme) => {
    try {
      await api.saveDefaultTheme(t);
      setOrgTheme(t);
      setMsg({ ok: true, text: `Organization default set to ${THEME_LABEL[t].toLowerCase()}. People who chose their own theme keep it.` });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    }
  };
  return (
    <>
      <p className="field" style={{ margin: '0 0 6px' }}>Your theme (this browser)</p>
      <div role="radiogroup" aria-label="Your theme" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button role="radio" aria-checked={theme === null} onClick={() => setTheme(null)}
          className={`btn${theme === null ? ' btn--primary' : ''}`}>Organization default ({orgLabel})</button>
        {THEMES.map((t) => (
          <button key={t} role="radio" aria-checked={theme === t} onClick={() => setTheme(t)}
            className={`btn${theme === t ? ' btn--primary' : ''}`}>{THEME_LABEL[t]}</button>
        ))}
      </div>
      {manage && (
        <>
          <p className="field" style={{ margin: '16px 0 6px' }}>Organization default
            <small>What everyone sees until they choose their own (also the sign-in page in their browser). Light if not set.</small>
          </p>
          <div role="radiogroup" aria-label="Organization default theme" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {THEMES.map((t) => (
              <button key={t} role="radio" aria-checked={(orgTheme ?? 'light') === t} onClick={() => void saveOrg(t)}
                className={`btn${(orgTheme ?? 'light') === t ? ' btn--primary' : ''}`}>{THEME_LABEL[t]}</button>
            ))}
          </div>
        </>
      )}
      {msg && <p className={`notice${msg.ok ? '' : ' notice--error'}`} style={{ marginTop: 12 }}>{msg.text}</p>}
    </>
  );
}

const SERVICES: Record<string, string> = {
  database: 'Database (PostgreSQL)',
  'gateway-back': 'Gateway',
  'stream-hub': 'Stream hub',
  'ml-service': 'Fall detector (ML service)',
};

function GatewaySettings() {
  const [cfg, setCfg] = useState<GatewayConfig | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.gatewayConfig().then(setCfg).catch((e) => setMessage({ ok: false, text: e.message }));
  }, []);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!cfg) return;
    setSaving(true);
    try {
      await api.saveGatewayConfig(cfg);
      setMessage({ ok: true, text: 'Saved. Cameras pick up the new address when they reconnect.' });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="card" style={{ padding: 20 }}>
      <h2 className="section-title">Gateway</h2>
      {message && <p className={`notice${message.ok ? '' : ' notice--error'}`}>{message.text}</p>}
      {cfg && (
        <form onSubmit={save} className="stack">
          <label className="field">Stream hub address
            <input value={cfg.cloud_address} onChange={(e) => setCfg({ ...cfg, cloud_address: e.target.value })} required />
            <small>Where the gateway sends video, host:port (stream-hub:8090 inside Docker)</small>
          </label>
          <p className="muted" style={{ margin: 0 }}>Tenant: <span className="mono">{cfg.tenant_id}</span></p>
          <div><button className="btn btn--primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button></div>
        </form>
      )}
    </section>
  );
}

export default function SettingsPage() {
  const { liveLayout, setLiveLayout } = useUiStore();
  const { data: health, error } = usePolling(() => api.health(), 5000);
  const { me, can } = useAuth();
  const manage = can(PERM.manageSettings);

  return (
    <>
      <PageHeader title="Settings" description="Organization details, system status, gateway connection, emails sent and appearance." />
      <div className="stack" style={{ maxWidth: 720 }}>
        <section className="card" style={{ padding: 20 }}>
          <h2 className="section-title">System status</h2>
          {error && <p className="notice notice--error">{error}</p>}
          {health && (
            <table className="table">
              <tbody>
                {Object.entries(SERVICES).map(([key, label]) => {
                  const s = health.services[key];
                  return (
                    <tr key={key}>
                      <td>{label}</td>
                      <td>{s ? <StatusBadge value={s.ok ? 'online' : 'offline'} label={s.ok ? 'Running' : 'Unreachable'} /> : '—'}</td>
                      <td className="num muted">{s?.ok ? `${s.latency_ms} ms` : <span title={s?.error}>{s?.error?.slice(0, 60)}</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>

        <OrgProfileSettings editable={manage} />

        <fieldset disabled={!manage} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <TimeZoneSettings />
        </fieldset>

        {manage && me?.org.has_gateway && <GatewaySettings />}

        {can(PERM.viewEmails) && <EmailsSentSettings />}

        <section className="card" style={{ padding: 20 }}>
          <h2 className="section-title">Appearance</h2>
          <ThemeSettings manage={manage} />
          <label className="field" style={{ marginTop: 16, maxWidth: 320 }}>Live View default layout
            <select value={liveLayout} onChange={(e) => setLiveLayout(e.target.value as LiveLayout)}>
              <option value="auto">Auto: every camera, scroll for more</option>
              <option value="1">1 camera per page</option>
              <option value="2">2 cameras per page</option>
              <option value="4">4 cameras per page (2 × 2)</option>
              <option value="8">8 cameras per page (4 × 2)</option>
              <option value="fit">Fit all cameras to the window</option>
            </select>
            <small>Saved in this browser. Live View can also switch layout and "Set as default".</small>
          </label>
        </section>
      </div>
    </>
  );
}
