import { useEffect, useRef, useState } from 'react';
import { useBlocker } from 'react-router-dom';

/**
 * Asks before leaving a page that has unsaved changes: moving to another page in the app opens
 * a dialog (stay, save and leave, or leave without saving); closing or reloading the tab shows
 * the browser's own warning. onSave resolves true when the changes were saved.
 */
export function UnsavedChangesGuard({ when, onSave }: { when: boolean; onSave?: () => Promise<boolean> }) {
  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    when && currentLocation.pathname !== nextLocation.pathname);
  const dialog = useRef<HTMLDialogElement>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!when) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [when]);

  const open = blocker.state === 'blocked';
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  const stay = () => { if (blocker.state === 'blocked') blocker.reset(); };
  const leave = () => { if (blocker.state === 'blocked') blocker.proceed(); };
  const saveAndLeave = async () => {
    if (!onSave) return;
    setSaving(true);
    const ok = await onSave();
    setSaving(false);
    if (ok) leave();
    else stay(); // the page shows why saving failed
  };

  return (
    <dialog ref={dialog} className="confirm-dialog" aria-labelledby="unsaved-title" aria-describedby="unsaved-body"
      onCancel={(e) => { e.preventDefault(); stay(); }}>
      <h2 id="unsaved-title" className="confirm-dialog__title">Unsaved changes</h2>
      <p id="unsaved-body" className="confirm-dialog__body">
        You have changes on this page that haven't been saved. If you leave now, they will be lost.
      </p>
      <div className="confirm-dialog__actions">
        <button className="btn btn--danger" disabled={saving} onClick={leave}>Leave without saving</button>
        <span style={{ flex: 1 }} />
        <button className="btn" autoFocus disabled={saving} onClick={stay}>Stay on this page</button>
        {onSave && (
          <button className="btn btn--primary" disabled={saving} onClick={() => void saveAndLeave()}>
            {saving ? 'Saving…' : 'Save and leave'}
          </button>
        )}
      </div>
    </dialog>
  );
}
