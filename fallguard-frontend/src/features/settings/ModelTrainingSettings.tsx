import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { formatTime } from '../../lib/format';

/**
 * Opt in to model training: let FallGuard keep this organization's fall videos and the team's
 * review decisions to improve the detector. Frontend only for now: the choice is kept in this
 * browser until the server side exists (see Future improvements in the README).
 */
interface Choice { optIn: boolean; at: string; by: string }

const key = (orgId: string) => `fallguard-model-training:${orgId}`;

function load(orgId: string): Choice | null {
  try {
    return JSON.parse(localStorage.getItem(key(orgId)) ?? 'null');
  } catch {
    return null;
  }
}

export function ModelTrainingSettings({ manage }: { manage: boolean }) {
  const { me } = useAuth();
  const orgId = me?.org.id ?? '';
  const [choice, setChoice] = useState<Choice | null>(() => (orgId ? load(orgId) : null));
  const dialog = useRef<HTMLDialogElement>(null);
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (asking && !d.open) d.showModal();
    if (!asking && d.open) d.close();
  }, [asking]);

  const save = (optIn: boolean) => {
    const c = { optIn, at: new Date().toISOString(), by: me ? `${me.user.first_name} ${me.user.last_name}`.trim() : '' };
    localStorage.setItem(key(orgId), JSON.stringify(c));
    setChoice(c);
    setAsking(false);
  };
  const optedIn = choice?.optIn ?? false;

  return (
    <section className="card" style={{ padding: 20 }}>
      <h2 className="section-title">Help improve fall detection</h2>
      <p className="muted" style={{ marginTop: 0, lineHeight: 1.5 }}>
        With your permission, FallGuard keeps your organization's fall videos and your team's review decisions
        (for example <em>false alarm</em> or <em>resolved</em>) to train future versions of the detector, so it
        misses fewer falls and raises fewer false alarms. They are kept for <strong>at most 2 years</strong>, or
        until the training they are used for is finished if that comes first, and then deleted.
        Off unless an admin opts in; you can opt out at any time.
      </p>
      <div className="row" style={{ alignItems: 'center', gap: 12 }}>
        <span>Status: <strong>{optedIn ? 'Opted in' : 'Not opted in'}</strong></span>
        {manage && (optedIn
          ? <button className="btn" onClick={() => save(false)}>Opt out</button>
          : <button className="btn btn--primary" onClick={() => setAsking(true)}>Opt in…</button>)}
      </div>
      {choice && (
        <p className="muted" style={{ marginBottom: 0, fontSize: 13 }}>
          {choice.optIn ? 'Opted in' : 'Opted out'}{choice.by ? ` by ${choice.by}` : ''} · {formatTime(choice.at)}
        </p>
      )}
      {!manage && <p className="muted" style={{ marginBottom: 0, fontSize: 13 }}>Only admins can change this.</p>}
      <p className="muted" style={{ marginBottom: 0, fontSize: 12 }}>
        Preview: this choice is saved in this browser only, not yet for the whole organization.
      </p>

      <dialog ref={dialog} className="confirm-dialog" aria-labelledby="mt-title" aria-describedby="mt-body"
        onCancel={(e) => { e.preventDefault(); setAsking(false); }}>
        <h2 id="mt-title" className="confirm-dialog__title">Opt in to model training?</h2>
        <div id="mt-body" className="confirm-dialog__body">
          <p style={{ marginTop: 0 }}>FallGuard will keep your fall videos and review decisions for up to 2 years to improve the detector. Please consider:</p>
          <ul style={{ paddingLeft: 18, margin: 0, display: 'grid', gap: 6 }}>
            <li><strong>Privacy:</strong> the videos show residents and staff, possibly in private moments. Make sure your consent policies cover this use.</li>
            <li><strong>Longer storage:</strong> these videos are kept beyond your normal retention, so they stay exposed to the usual security risks for longer.</li>
            <li><strong>Training already done:</strong> opting out stops new data from being used and deletes what was kept, but can't undo training that has already finished.</li>
          </ul>
        </div>
        <div className="confirm-dialog__actions">
          <span style={{ flex: 1 }} />
          <button className="btn" autoFocus onClick={() => setAsking(false)}>Cancel</button>
          <button className="btn btn--primary" onClick={() => save(true)}>Yes, opt in</button>
        </div>
      </dialog>
    </section>
  );
}
