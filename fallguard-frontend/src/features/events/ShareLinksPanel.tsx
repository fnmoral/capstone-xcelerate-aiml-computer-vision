import { useState, type FormEvent } from 'react';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { Icon } from '../../components/ui/Icon';
import { shareLinks, type ShareLink } from '../../services/api/accounts';
import { usePolling } from '../../services/api/usePolling';
import { formatTime } from '../../lib/format';

const DAYS = [1, 7, 14, 30, 90];

const state = (l: ShareLink) =>
  l.revoked_at ? 'Revoked' : Date.parse(l.expires_at) <= Date.now() ? 'Expired' : 'Active';

/** Incident page section: view-only links to this incident's video, for people without an
 *  account (e.g. a regulator). The link is shown once, right after it is created. */
export function ShareLinksPanel({ incidentId }: { incidentId: string }) {
  const { data, error, reload } = usePolling(() => shareLinks.list(incidentId), 30000, [incidentId]);
  const [recipient, setRecipient] = useState('');
  const [days, setDays] = useState(14);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ url: string; recipient: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const r = await shareLinks.create(incidentId, { recipient, days });
      setCreated({ url: r.url, recipient: r.link.recipient });
      setCopied(false);
      setRecipient('');
      await reload();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (l: ShareLink) => {
    if (!confirm(`Revoke the link for ${l.recipient}? It stops working at once.`)) return;
    try {
      await shareLinks.revoke(l.id);
      await reload();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const copy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.url);
      setCopied(true);
    } catch {
      setMsg('Copy failed: select the link and copy it.');
    }
  };

  const links = data?.links ?? [];
  return (
    <>
      <p className="muted" style={{ marginTop: 0 }}>
        A view-only page with this incident's video and its time, place and outcome, for someone without an account,
        such as a regulator. No notes or staff names are shown. Anyone with the link can watch until it expires or is revoked,
        so send it only to the intended recipient. Every view is logged in the history.
      </p>
      {error && <p className="notice notice--error">{error}</p>}
      {msg && <p className="notice notice--error">{msg}</p>}
      {created && (
        <div className="notice share-created" role="status">
          <strong>Link for {created.recipient}</strong>: copy it now, it is shown only once.
          <div className="share-created__row">
            <input readOnly value={created.url} onFocus={(e) => e.target.select()} aria-label="Share link" />
            <button className="btn btn--sm" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</button>
            <a className="btn btn--sm" href={created.url} target="_blank" rel="noreferrer">Open</a>
          </div>
        </div>
      )}
      <form className="share-form" onSubmit={create}>
        <label className="field">For
          <input value={recipient} required maxLength={120} placeholder="e.g. WSIB claims, Ministry of Labour inspector"
            onChange={(e) => setRecipient(e.target.value)} />
        </label>
        <label className="field">Expires after
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {DAYS.map((d) => <option key={d} value={d}>{d} day{d > 1 ? 's' : ''}</option>)}
          </select>
        </label>
        <button className="btn btn--primary" disabled={busy}><Icon name="file" size={16} /> {busy ? 'Creating…' : 'Create link'}</button>
      </form>
      {links.length > 0 && (
        <ul className="ev-list">
          {links.map((l) => {
            const s = state(l);
            return (
              <li key={l.id}>
                <strong>{l.recipient}</strong>{' '}
                <StatusBadge value={s === 'Active' ? 'acknowledged' : 'resolved'} label={s} />
                <div className="muted ev-sub">
                  {l.created_by ?? 'Someone'} · created {formatTime(l.created_at)} · {{ Active: 'expires', Expired: 'expired', Revoked: 'revoked' }[s]} {formatTime(l.revoked_at ?? l.expires_at)}
                  {' · '}{l.views} view{l.views === 1 ? '' : 's'}{l.last_viewed_at ? `, last ${formatTime(l.last_viewed_at)}` : ''}
                </div>
                {s === 'Active' && <button className="btn btn--sm" onClick={() => void revoke(l)}>Revoke</button>}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
