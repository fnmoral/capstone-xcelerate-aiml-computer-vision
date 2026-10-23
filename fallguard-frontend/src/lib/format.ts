/** Display helpers shared by the pages. */

import { useUiStore } from '../store/uiStore';

export const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The time zone the app shows times in: the facility's (Settings), else this browser's. */
export const appTimeZone = () => useUiStore.getState().timeZone || browserTimeZone;

const dayKey = (d: Date, timeZone: string) => d.toLocaleDateString('en-CA', { timeZone });

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const timeZone = appTimeZone();
  const sameDay = dayKey(d, timeZone) === dayKey(new Date(), timeZone);
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone });
}

/** Full date and time, e.g. for logs. */
export const formatDateTime = (iso: string) => new Date(iso).toLocaleString([], { timeZone: appTimeZone() });

/** A wall-clock time typed in a datetime-local field ("2026-10-23T08:00"), read in the app's
 *  time zone, as an ISO instant. */
export function zonedToIso(local: string, timeZone = appTimeZone()): string {
  const [date, time = '00:00'] = local.split('T');
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  // The zone's offset from UTC at an instant, in ms.
  const offset = (at: number) => {
    const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - at;
  };
  const first = wall - offset(wall);
  return new Date(wall - offset(first)).toISOString(); // second pass: right across DST changes
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
  not_working: 'Not working',
  connecting: 'Waiting for video',
  not_connected: 'Not connected',
};

/**
 * "Current user · 14:02:10" for who-did-what lines. `unknown` is shown when nobody is
 * recorded: "System" in the activity log; for alerts, "Not recorded" (handled before
 * actions were logged).
 */
export const byWhen = (who: string | null | undefined, at: string | null | undefined, unknown = 'System') =>
  [who ?? unknown, formatTime(at)].join(' · ');

/** Who acknowledged or closed an alert. */
export const alertBy = (who: string | null | undefined, at: string | null | undefined) => byWhen(who, at, 'Not recorded');

export const shortId = (id: string) => id.slice(0, 8);
