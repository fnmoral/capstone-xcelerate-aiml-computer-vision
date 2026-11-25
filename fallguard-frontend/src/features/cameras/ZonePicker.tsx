import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from '../../components/ui/Icon';

/**
 * Zone field of the camera forms: a dropdown of the zones already used, "No zone", and
 * "New zone…" to type a new one. (It replaces a text box with browser suggestions.)
 */
export function ZoneField({ value, onChange, zones, hint }: {
  value: string; onChange: (zone: string) => void; zones: string[]; hint?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState('');
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);

  // A zone typed earlier in this form but not saved yet is listed too.
  const all = [...new Set([...zones, ...(value ? [value] : [])])].sort((a, b) => a.localeCompare(b));
  const options: { key: string; label: string; zone: string | null }[] = [
    { key: '', label: 'No zone', zone: '' },
    ...all.map((z) => ({ key: 'z:' + z, label: z, zone: z })),
    { key: 'new', label: 'New zone…', zone: null },
  ];

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) close();
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [open]);
  useEffect(() => {
    if (typing) input.current?.focus();
  }, [typing]);

  const close = (focusButton = false) => {
    setOpen(false);
    setTyping(false);
    setDraft('');
    if (focusButton) button.current?.focus();
  };
  const openList = () => {
    setActive(Math.max(0, options.findIndex((o) => o.zone === value)));
    setOpen(true);
  };
  const choose = (o: (typeof options)[number]) => {
    if (o.zone === null) {
      setTyping(true);
      return;
    }
    onChange(o.zone);
    close(true);
  };
  const addDraft = () => {
    const z = draft.trim();
    if (!z) return;
    onChange(z);
    close(true);
  };

  const onButtonKey = (e: KeyboardEvent) => {
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      openList();
      return;
    }
    if (!open || typing) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(options.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(options.length - 1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(options[active]); }
    else if (e.key === 'Escape' || e.key === 'Tab') close(e.key === 'Escape');
  };

  return (
    <div className="field zone-field" ref={box}>
      <span id={`${id}-label`}>Zone</span>
      <div className="zone-field__anchor">
      <button ref={button} type="button" className={`zone-field__btn${value ? '' : ' zone-field__btn--empty'}`}
        aria-haspopup="listbox" aria-expanded={open} aria-labelledby={`${id}-label ${id}-value`}
        aria-activedescendant={open && !typing ? `${id}-o${active}` : undefined}
        onClick={() => (open ? close() : openList())} onKeyDown={onButtonKey}>
        <span id={`${id}-value`}>{value || 'No zone'}</span>
      </button>
      {open && (
        <div className="zone-field__panel">
          {typing ? (
            <div className="zone-field__new">
              <input ref={input} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="e.g. Ward A, east wing"
                maxLength={60} aria-label="New zone name"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); addDraft(); }
                  if (e.key === 'Escape') { e.preventDefault(); close(true); }
                }} />
              <button type="button" className="btn btn--sm btn--primary" disabled={!draft.trim()} onClick={addDraft}>Add</button>
            </div>
          ) : (
            <ul className="zone-field__list" role="listbox" aria-labelledby={`${id}-label`}>
              {options.map((o, i) => (
                <li key={o.key} id={`${id}-o${i}`} role="option" aria-selected={o.zone === value}
                  className={`zone-field__option${i === active ? ' is-active' : ''}${o.zone === null ? ' zone-field__option--new' : ''}${o.zone === '' ? ' zone-field__option--none' : ''}`}
                  onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(o)}>
                  <span>{o.label}</span>
                  {o.zone === value && <Icon name="check" size={15} />}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      </div>
      {hint && <small>{hint}</small>}
    </div>
  );
}
