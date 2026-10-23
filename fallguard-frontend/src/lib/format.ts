/** Display helpers shared by the pages. */

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  return m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 60)} h`;
}

/** Seconds since an ISO time (for incidents still in progress). */
export function secondsSince(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 1000;
}

export const LABEL_TEXT: Record<string, string> = {
  upright: 'Upright',
  falling: 'Falling',
  lying: 'Lying',
};

export const STATUS_TEXT: Record<string, string> = {
  active: 'Active',
  recovered: 'Recovered',
  unresolved: 'Unresolved',
  false_positive: 'False positive',
  open: 'Open',
  acknowledged: 'Acknowledged',
  resolved: 'Resolved',
  online: 'Online',
  paused: 'Paused',
  not_on_gateway: 'Not on gateway',
};

export const shortId = (id: string) => id.slice(0, 8);
