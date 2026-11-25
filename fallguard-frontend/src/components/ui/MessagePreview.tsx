import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';

/** What a sent message looked like: the email's HTML, or plain text (SMS, older emails). */
export interface MessageContent {
  html?: string | null;
  text?: string | null;
  note?: string; // e.g. why the text isn't available
}

/**
 * A floating preview of a sent email or text message (Emails sent, Recent messages).
 * load() fetches the content when it opens. The email is shown in a sandboxed frame:
 * no scripts, and its links can't be followed from here.
 */
export function MessagePreview({ title, meta, load, sms, onClose }: {
  title: string;
  meta: { label: string; value: ReactNode }[];
  load: () => Promise<MessageContent>;
  sms?: boolean;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [content, setContent] = useState<MessageContent | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  }, []);
  useEffect(() => {
    let live = true;
    load().then((c) => live && setContent(c), (e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [load]);

  return (
    <dialog ref={dialog} className="msg-preview" aria-labelledby="msg-preview-title"
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="msg-preview__card">
        <header className="msg-preview__head">
          <h2 id="msg-preview-title" className="msg-preview__title">{title}</h2>
          <button type="button" className="msg-preview__close" onClick={onClose} aria-label="Close preview" autoFocus>
            <Icon name="close" size={18} />
          </button>
        </header>
        <dl className="msg-preview__meta">
          {meta.map((m) => (
            <div key={m.label}><dt>{m.label}</dt><dd>{m.value}</dd></div>
          ))}
        </dl>
        <div className="msg-preview__body">
          {error ? <p className="notice notice--error">{error}</p>
            : !content ? <p className="muted msg-preview__loading">Loading…</p>
            : content.html ? (
              <iframe className="msg-preview__frame" title={`Preview: ${title}`} sandbox="" srcDoc={content.html} />
            ) : content.text ? (
              <div className={sms ? 'msg-preview__sms' : 'msg-preview__text'}>{content.text}</div>
            ) : null}
          {content?.note && <p className="muted msg-preview__note">{content.note}</p>}
        </div>
      </div>
    </dialog>
  );
}
