import { useEffect, useRef, useState, type FormEvent } from 'react';
import { accounts } from '../../services/api/accounts';
import { useAuth } from './AuthContext';

const MAX = 40;

/**
 * Temporary access visitors: asks once per browser for an optional name. What they do
 * (acknowledge an alert, add a note…) is then logged as "Sam (visitor)", else as
 * "Demo visitor <link label>".
 */
export function VisitorNamePrompt() {
  const { me, refresh } = useAuth();
  const ask = !!me?.user.is_guest && me.user.visitor_name === undefined;
  return ask ? <VisitorNameDialog current="" onDone={() => void refresh()} /> : null;
}

export function VisitorNameDialog({ current, onDone }: { current: string; onDone: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  }, []);

  const save = async (value: string) => {
    setBusy(true);
    setError(null);
    try {
      await accounts.setVisitorName(value.trim());
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void save(name);
  };

  return (
    <dialog ref={dialog} className="visitor-name" aria-labelledby="visitor-name-title"
      onCancel={(e) => { e.preventDefault(); if (busy) return; if (current) onDone(); else void save(''); }}>
      <form className="visitor-name__card" onSubmit={submit}>
        <h2 id="visitor-name-title" className="visitor-name__title">{current ? 'Change your name' : 'Welcome'}</h2>
        <p className="muted visitor-name__text">
          Your name is optional. If you respond to an alert or add a note, the activity log shows it, so
          the team knows who did what. Leave it empty to appear as a demo visitor.
        </p>
        <label className="field">Your name (optional)
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={MAX} autoFocus
            autoComplete="name" placeholder="e.g. Sam from Maple Grove" />
        </label>
        {error && <p className="notice notice--error" role="alert">{error}</p>}
        <div className="visitor-name__actions">
          {current && <button type="button" className="btn" disabled={busy} onClick={onDone}>Cancel</button>}
          <button className="btn btn--primary" disabled={busy}>{busy ? 'Saving…' : name.trim() ? 'Continue' : 'Continue without a name'}</button>
        </div>
      </form>
    </dialog>
  );
}
