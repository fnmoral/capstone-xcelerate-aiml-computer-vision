import { useState, type FormEvent } from 'react';
import { api } from '../../services/api/fallguard';
import { byWhen } from '../../lib/format';
import { useUiStore } from '../../store/uiStore';
import type { Note } from '../../types/domain';

/** An incident's notes (oldest first) and a form to add one. Notes are never overwritten. */
export function Notes({ incidentId, notes, onAdded }: { incidentId: string; notes: Note[]; onAdded: () => unknown }) {
  const { noteAuthor, setNoteAuthor } = useUiStore();
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.addNote(incidentId, { author: noteAuthor.trim(), text });
      setText('');
      await onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {notes.length === 0 ? <p className="muted">No notes yet.</p> : (
        <ol className="notes" aria-label="Notes">
          {notes.map((n, i) => (
            <li key={i}>
              <span className="notes__text">{n.text}</span>
              <span className="notes__by">{byWhen(n.author, n.at)}</span>
            </li>
          ))}
        </ol>
      )}
      <form onSubmit={submit} className="stack" style={{ gap: 8 }}>
        {error && <p className="notice notice--error">{error}</p>}
        <label className="field">Your name
          <input value={noteAuthor} onChange={(e) => setNoteAuthor(e.target.value)} maxLength={80}
            placeholder="Current user" autoComplete="name" />
          <small>Remembered in this browser (no user accounts yet)</small>
        </label>
        <label className="field">Add a note
          <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={4000} required
            placeholder="What happened, who responded…" />
        </label>
        <div className="row">
          <button className="btn btn--primary" disabled={saving || !text.trim()}>{saving ? 'Adding…' : 'Add note'}</button>
        </div>
      </form>
    </>
  );
}
