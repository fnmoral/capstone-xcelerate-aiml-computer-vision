import './ui.css';

export type WindowPreset = '24h' | '7d' | '30d' | 'all' | 'custom';

/** A time window: a preset, or custom from/to as datetime-local strings (browser time). */
export interface TimeWindowValue {
  preset: WindowPreset;
  from: string;
  to: string;
}

export const DEFAULT_WINDOW: TimeWindowValue = { preset: '7d', from: '', to: '' };

const PRESETS: { value: WindowPreset; label: string; hours?: number }[] = [
  { value: '24h', label: 'Last 24 h', hours: 24 },
  { value: '7d', label: '7 days', hours: 24 * 7 },
  { value: '30d', label: '30 days', hours: 24 * 30 },
  { value: 'all', label: 'All time' },
  { value: 'custom', label: 'Custom…' },
];

/** ISO from/to for the API. Call it when fetching, so "last 24 h" always ends now. */
export function resolveWindow(w: TimeWindowValue): { from?: string; to?: string } {
  if (w.preset === 'custom') {
    const iso = (v: string) => (v ? new Date(v).toISOString() : undefined);
    return { from: iso(w.from), to: iso(w.to) };
  }
  const hours = PRESETS.find((p) => p.value === w.preset)?.hours;
  return hours ? { from: new Date(Date.now() - hours * 3600_000).toISOString() } : {};
}

/** Preset buttons, plus from / to date-and-time fields for a custom window. */
export function TimeWindow({ value, onChange }: { value: TimeWindowValue; onChange: (v: TimeWindowValue) => void }) {
  return (
    <div className="time-window">
      <div className="tabs" role="group" aria-label="Time window">
        {PRESETS.map((p) => (
          <button key={p.value} type="button" className="tab" aria-pressed={value.preset === p.value}
            onClick={() => onChange({ ...value, preset: p.value })}>{p.label}</button>
        ))}
      </div>
      {value.preset === 'custom' && (
        <div className="row">
          <label className="field">From
            <input type="datetime-local" value={value.from} max={value.to || undefined}
              onChange={(e) => onChange({ ...value, from: e.target.value })} />
          </label>
          <label className="field">To
            <input type="datetime-local" value={value.to} min={value.from || undefined}
              onChange={(e) => onChange({ ...value, to: e.target.value })} />
          </label>
        </div>
      )}
    </div>
  );
}
