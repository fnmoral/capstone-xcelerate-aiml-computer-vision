import { useState, type FormEvent } from 'react';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { Icon } from '../../components/ui/Icon';
import { accounts, type GuestLink } from '../../services/api/accounts';
import { usePolling } from '../../services/api/usePolling';
import { formatTime } from '../../lib/format';

const DURATIONS: [number, string][] = [
  [12, '12 hours'], [24, '1 day'], [72, '3 days'], [168, '7 days'], [336, '14 days'], [720, '30 days'],
];

const errorText = (e: unknown) => (e instanceof Error ? e.message.charAt(0).toUpperCase() + e.message.slice(1) : String(e));

/** Members page: view-only demo links (no account needed), each lasting a set time. */
export function DemoLinks() {
  const { data, error, reload } = usePolling(() => accounts.guestLinks(), 30000);
  const [label, setLabel] = useState('');
  const [hours, setHours] = useState(24);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ url: string; link: GuestLink } | null>(null);
  const [copied, setCopied] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    setCopied(false);
    try {
      setCreated(await accounts.createGuestLink(label, hours));
      setLabel('');
      void reload();
    } catch (err) {
      setMsg(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const revoke = async (l: GuestLink) => {
    if (!confirm(`End "${l.label}" now? Everyone using it is signed out straight away.`)) return;
    try {
      await accounts.revokeGuestLink(l.id);
      void reload();
    } catch (err) {
      setMsg(errorText(err));
    }
  };

  const links = data?.links ?? [];
  return (
    <section className="card members-section">
      <h2 className="section-title">Demo access links</h2>
      <p className="muted" style={{ marginTop: -6 }}>
        Let visitors look around without an account. Anyone with the link can watch the cameras and see fall events,
        reports and logs (view-only, they can't change anything or see the members list) until the time runs out.
      </p>
      {(msg || error) && <p className="notice notice--error">{msg ?? error}</p>}
      <form onSubmit={create} className="invite-form">
        <label className="field">Label
          <input value={label} onChange={(e) => setLabel(e.target.value)} required maxLength={60} placeholder="e.g. Capstone demo day" />
        </label>
        <label className="field">Access lasts
          <select value={hours} onChange={(e) => setHours(Number(e.target.value))}>
            {DURATIONS.map(([h, text]) => <option key={h} value={h}>{text}</option>)}
          </select>
        </label>
        <button className="btn btn--primary" disabled={busy}><Icon name="plus" size={16} /> {busy ? 'Creating…' : 'Create demo link'}</button>
      </form>
      {created && (
        <div className="notice demo-created" role="status">
          <p style={{ margin: '0 0 6px' }}><strong>{created.link.label}</strong> works until {formatTime(created.link.expires_at)}.
            Copy it now: for safety it isn't shown again (create a new one if you lose it).</p>
          <div className="row">
            <input readOnly value={created.url} className="mono demo-created__url" onFocus={(e) => e.target.select()} aria-label="Demo link" />
            <button className="btn btn--sm" onClick={() => void copy(created.url)}>{copied ? 'Copied' : 'Copy link'}</button>
          </div>
        </div>
      )}
      {links.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table className="table">
            <thead><tr><th>Label</th><th>Status</th><th>Visits</th><th>Created by</th><th /></tr></thead>
            <tbody>
              {links.map((l) => (
                <tr key={l.id}>
                  <td><strong>{l.label}</strong><div className="muted members-sub">created {formatTime(l.created_at)}</div></td>
                  <td>
                    {l.status === 'active'
                      ? <StatusBadge value="online" label={`Until ${formatTime(l.expires_at)}`} />
                      : <StatusBadge value="paused" label={l.status === 'revoked' ? `Ended ${formatTime(l.revoked_at)}` : `Expired ${formatTime(l.expires_at)}`} />}
                  </td>
                  <td className="muted">{l.visits}{l.last_visit_at && <div className="members-sub">last {formatTime(l.last_visit_at)}</div>}</td>
                  <td className="muted">{l.created_by ?? '—'}</td>
                  <td className="num">{l.status === 'active' && <button className="btn btn--sm btn--danger" onClick={() => void revoke(l)}>End now</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
