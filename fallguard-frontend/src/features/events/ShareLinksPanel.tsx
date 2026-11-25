import { useState, type FormEvent } from 'react';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { Icon } from '../../components/ui/Icon';
import { shareLinks, type ShareLink, type ShareView } from '../../services/api/accounts';
import { usePolling } from '../../services/api/usePolling';
import { formatTime } from '../../lib/format';

const DAYS = [1, 7, 14, 30, 90];

const state = (l: ShareLink) =>
  l.revoked_at ? 'Revoked' : Date.parse(l.expires_at) <= Date.now() ? 'Expired' : 'Active';

/** "Chrome on Windows" from a browser's user agent (a summary; the full text is in the tooltip). */
export function browserOf(ua: string): string {
  if (!ua) return 'Unknown browser';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /curl|wget|python|bot|spider/i.test(ua) ? 'Script or bot' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android'
    : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

/** One share link: who it's for, status, expiry, views (time, IP address, browser), revoke. */
function LinkCard({ l, onRevoke }: { l: ShareLink; onRevoke: () => void }) {
  const s = state(l);
  const [views, setViews] = useState<ShareView[] | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = async () => {
    if (open) { setOpen(false); return; }
    setOpen(true);
    try {
      setViews((await shareLinks.views(l.id)).views);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <li className={`share-card${s === 'Active' ? '' : ' share-card--ended'}`}>
      <div className="share-card__head">
        <div className="share-card__body">
          <span className="share-card__title">
            <strong>{l.recipient}</strong>
            <StatusBadge value={s === 'Active' ? 'acknowledged' : 'resolved'} label={s} />
          </span>
          <span className="muted share-card__meta">
            {l.created_by ?? 'Someone'} · created {formatTime(l.created_at)} · {{ Active: 'expires', Expired: 'expired', Revoked: 'revoked' }[s]} {formatTime(l.revoked_at ?? l.expires_at)}
          </span>
        </div>
        <div className="row share-card__actions">
          <button className="btn btn--sm" disabled={l.views === 0} onClick={() => void toggle()}>
            {l.views} view{l.views === 1 ? '' : 's'}{l.views > 0 ? (open ? ' ▲' : ' ▼') : ''}
          </button>
          {s === 'Active' && <button className="btn btn--sm btn--danger" onClick={onRevoke}>Revoke</button>}
        </div>
      </div>
      {open && (
        <div className="share-views">
          {error && <p className="notice notice--error">{error}</p>}
          {!views && !error && <p className="muted">Loading…</p>}
          {views && (
            <table className="table table--stack share-views__table">
              <thead><tr><th>Opened</th><th>IP address</th><th>Browser</th></tr></thead>
              <tbody>
                {views.map((v, i) => (
                  <tr key={i}>
                    <td>{formatTime(v.at)}</td>
                    <td className="mono">{v.ip || '—'}</td>
                    <td title={v.user_agent}>{browserOf(v.user_agent)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="muted share-views__note">IP addresses identify a network (often a company or internet provider), not a person.</p>
        </div>
      )}
    </li>
  );
}

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
      <p className="muted share-intro">
        Share this incident's video with a recipient who has no FallGuard account, such as a regulator or insurer.
        The link opens a view-only page with the video, time, location and outcome; notes and staff names are not included.
      </p>
      <p className="muted share-intro">
        Anyone with the link can view it until it expires or is revoked, so send it only to the intended recipient.
        Each view is recorded in the incident history.
      </p>
      {error && <p className="notice notice--error">{error}</p>}
      {msg && <p className="notice notice--error">{msg}</p>}
      {links.length > 0 && (
        <ul className="share-list">
          {links.map((l) => <LinkCard key={l.id} l={l} onRevoke={() => void revoke(l)} />)}
        </ul>
      )}
      {created && (
        <div className="notice share-created" role="status">
          <strong>Link created for {created.recipient}.</strong> Copy it now: for security it is shown only once.
          <div className="share-created__row">
            <input readOnly value={created.url} onFocus={(e) => e.target.select()} aria-label="Share link" />
            <button className="btn btn--sm" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</button>
            <a className="btn btn--sm" href={created.url} target="_blank" rel="noreferrer">Open</a>
          </div>
        </div>
      )}
      <form className="share-form" onSubmit={create}>
        <label className="field">Recipient
          <input value={recipient} required maxLength={120} placeholder="e.g. WSIB Claims, Ministry of Labour inspector"
            onChange={(e) => setRecipient(e.target.value)} />
        </label>
        <label className="field">Valid for
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {DAYS.map((d) => <option key={d} value={d}>{d} day{d > 1 ? 's' : ''}</option>)}
          </select>
        </label>
        <button className="btn btn--primary" disabled={busy}><Icon name="file" size={16} /> {busy ? 'Creating…' : 'Create link'}</button>
      </form>
    </>
  );
}
