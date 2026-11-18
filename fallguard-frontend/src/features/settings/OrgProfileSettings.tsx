import { useEffect, useState, type FormEvent } from 'react';
import { accounts, type OrgProfile } from '../../services/api/accounts';
import { useAuth } from '../auth/AuthContext';

const FIELDS: { key: keyof OrgProfile; label: string; hint?: string; wide?: boolean }[] = [
  { key: 'name', label: 'Organization name' },
  { key: 'legal_name', label: 'Legal name', hint: 'If different; used on government reports' },
  { key: 'address', label: 'Street address', wide: true },
  { key: 'city', label: 'City' },
  { key: 'province', label: 'Province / state' },
  { key: 'postal_code', label: 'Postal / ZIP code' },
  { key: 'country', label: 'Country' },
  { key: 'phone', label: 'Phone' },
  { key: 'business_type', label: 'Type of business', hint: 'e.g. long-term care home' },
  { key: 'wsib_firm_number', label: 'WSIB firm number', hint: 'Ontario: for WSIB Form 7' },
  { key: 'wsib_rate_group', label: 'WSIB rate group / class' },
  { key: 'establishment', label: 'OSHA establishment name', hint: 'US: for the OSHA 300 Log' },
];

/** Organization details, used to fill in incident reports. */
export function OrgProfileSettings({ editable }: { editable: boolean }) {
  const { refresh } = useAuth();
  const [p, setP] = useState<OrgProfile | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { accounts.org().then(setP).catch((e) => setMsg({ ok: false, text: e.message })); }, []);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!p) return;
    setBusy(true);
    try {
      setP(await accounts.saveOrg(p));
      await refresh();
      setMsg({ ok: true, text: 'Saved. New incident reports use these details.' });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" style={{ padding: 20 }}>
      <h2 className="section-title">Organization</h2>
      <p className="muted" style={{ marginTop: -6 }}>Shown on incident reports (WSIB, OHSA, OSHA).</p>
      {msg && <p className={`notice${msg.ok ? '' : ' notice--error'}`}>{msg.text}</p>}
      {p && (
        <form onSubmit={save}>
          <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0 }}>
            <div className="form-grid">
              {FIELDS.map((f) => (
                <label key={f.key} className="field" style={f.wide ? { gridColumn: '1 / -1' } : undefined}>{f.label}
                  <input value={p[f.key] ?? ''} required={f.key === 'name'} maxLength={f.key === 'name' ? 120 : 200}
                    onChange={(e) => setP({ ...p, [f.key]: e.target.value })} />
                  {f.hint && <small>{f.hint}</small>}
                </label>
              ))}
            </div>
            {editable && <div style={{ marginTop: 12 }}><button className="btn btn--primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></div>}
          </fieldset>
        </form>
      )}
    </section>
  );
}
