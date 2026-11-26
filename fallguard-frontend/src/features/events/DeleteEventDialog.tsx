import { useEffect, useRef, useState } from 'react';
import { api } from '../../services/api/fallguard';
import { formatTime } from '../../lib/format';
import type { Incident } from '../../types/domain';

/**
 * Super admins: delete a fall event, either to the bin (hidden everywhere, kept, restorable
 * from Manage organizations) or permanently (every record and its video gone).
 */
export function DeleteEventDialog({ incident, onClose, onDeleted }: {
  incident: Incident | null; onClose: () => void; onDeleted: (mode: 'bin' | 'forever') => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState<'bin' | 'forever'>('bin');
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (incident && !d.open) {
      setMode('bin');
      setSure(false);
      setError(null);
      d.showModal();
    }
    if (!incident && d.open) d.close();
  }, [incident]);

  const active = incident?.status === 'active';
  const remove = async () => {
    if (!incident) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteIncident(incident.id, mode);
      onDeleted(mode);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog ref={dialog} className="confirm-dialog ev-delete" aria-labelledby="ev-delete-title"
      onCancel={(e) => { e.preventDefault(); if (!busy) onClose(); }}>
      <h2 id="ev-delete-title" className="confirm-dialog__title">Delete this fall event?</h2>
      {incident && (
        <p className="confirm-dialog__body">
          <strong>{incident.location_label || incident.camera_name || 'Unknown camera'}</strong>, {formatTime(incident.started_at)}.
        </p>
      )}
      {active ? (
        <p className="notice notice--error">This fall is still in progress. Wait until the person recovers, or resolve the alert or mark it a false alarm first.</p>
      ) : (
        <div className="ev-delete__choices" role="radiogroup" aria-label="How to delete">
          <label className={`ev-delete__choice${mode === 'bin' ? ' is-on' : ''}`}>
            <input type="radio" name="ev-delete" checked={mode === 'bin'} onChange={() => setMode('bin')} />
            <span>
              <strong>Move to the bin</strong>
              <span className="muted">Hidden from Fall Events, alerts, analytics, reports and exports. The video, reports and
                logs are kept: restore it from Manage organizations → Fall event bin.</span>
            </span>
          </label>
          <label className={`ev-delete__choice${mode === 'forever' ? ' is-on' : ''}`}>
            <input type="radio" name="ev-delete" checked={mode === 'forever'} onChange={() => setMode('forever')} />
            <span>
              <strong>Delete permanently</strong>
              <span className="muted">Removes the event, its video and snapshots, alert and notifications, incident reports,
                share links and log entries. No trace is left.</span>
            </span>
          </label>
          {mode === 'forever' && (
            <label className="switch ev-delete__sure">
              <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />
              I understand this can't be undone
            </label>
          )}
        </div>
      )}
      {error && <p className="notice notice--error">{error}</p>}
      <div className="confirm-dialog__actions">
        <span style={{ flex: 1 }} />
        <button className="btn" autoFocus disabled={busy} onClick={onClose}>Cancel</button>
        {!active && (
          <button className={`btn ${mode === 'forever' ? 'btn--danger-solid' : 'btn--primary'}`}
            disabled={busy || (mode === 'forever' && !sure)} onClick={() => void remove()}>
            {busy ? 'Deleting…' : mode === 'bin' ? 'Move to bin' : 'Delete permanently'}
          </button>
        )}
      </div>
    </dialog>
  );
}
