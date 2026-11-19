import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { shareLinks, type SharedView } from '../../services/api/accounts';
import { apiUrl } from '../../services/api/client';
import '../auth/auth.css';
import './shared.css';

const OUTCOME: Record<string, string> = {
  active: 'The person was still down when this link was opened',
  recovered: 'The person got back up',
  unresolved: 'The person left the camera view while still down',
  false_positive: 'Marked as a false alarm',
};

function duration(sec: number | null) {
  if (sec == null) return null;
  const m = Math.floor(sec / 60), s = sec % 60;
  return m ? `${m} min ${s} s` : `${s} seconds`;
}

/** Public, view-only page opened from a share link (no account): one incident's video and
 *  its time, place and outcome. The token in the URL is the permission. */
export default function SharedIncidentPage() {
  const { token = '' } = useParams();
  const [view, setView] = useState<SharedView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Keep the token out of any Referer header sent from this page.
    const meta = document.createElement('meta');
    meta.name = 'referrer';
    meta.content = 'no-referrer';
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);
  useEffect(() => {
    shareLinks.view(token).then(setView).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [token]);

  const when = (iso: string | null | undefined) => iso
    ? new Intl.DateTimeFormat('en-CA', { dateStyle: 'medium', timeStyle: 'medium', timeZone: view?.timezone || undefined }).format(new Date(iso))
    : '—';

  return (
    <main className="auth-page shared-page">
      <div className="card shared-card">
        <div className="auth-brand">
          <img src="/logo.jpeg" alt="" className="auth-logo" />
          <span>FallGuard <strong>Vision</strong></span>
        </div>
        {error && (
          <>
            <h1 className="auth-title">Link not available</h1>
            <p className="auth-subtitle">{error}. Ask the organization that sent it for a new link.</p>
          </>
        )}
        {!view && !error && <p className="muted">Loading…</p>}
        {view && (
          <>
            <h1 className="auth-title">Fall incident video</h1>
            <p className="auth-subtitle">Shared by {view.organization} · view-only · this link expires {when(view.expires_at)}</p>
            <dl className="shared-facts">
              <div><dt>Fall detected</dt><dd>{when(view.incident.started_at)}</dd></div>
              <div><dt>Location</dt><dd>{[view.incident.location, view.incident.zone && `zone ${view.incident.zone}`].filter(Boolean).join(', ') || '—'}</dd></div>
              <div><dt>Time on the ground</dt><dd>{duration(view.incident.duration_seconds) ?? '—'}</dd></div>
              <div><dt>Outcome</dt><dd>{OUTCOME[view.incident.status] ?? view.incident.status}</dd></div>
            </dl>
            {(view.media ?? []).length === 0 && <p className="notice">No video or photo was saved for this incident.</p>}
            {(view.media ?? []).map((m) => (
              <figure key={m.camera} className="shared-media">
                {m.clip
                  ? <video src={apiUrl(m.clip)} poster={m.snapshot ? apiUrl(m.snapshot) : undefined} controls preload="metadata" playsInline />
                  : m.snapshot && <img src={apiUrl(m.snapshot)} alt={`Photo from ${m.camera}`} />}
                <figcaption className="muted">{m.camera}</figcaption>
              </figure>
            ))}
            <p className="shared-note muted">
              Confidential: this video shows a person after a fall. It was shared for this incident only; please don't
              forward the link. Opening it is logged.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
