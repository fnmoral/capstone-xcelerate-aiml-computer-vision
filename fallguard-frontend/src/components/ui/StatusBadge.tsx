import { STATUS_TEXT } from '../../lib/format';
import './ui.css';

const TONE: Record<string, string> = {
  // incidents
  active: 'critical', unresolved: 'warning', recovered: 'good', false_positive: 'muted',
  // alerts
  open: 'critical', acknowledged: 'warning', resolved: 'good',
  // severity
  critical: 'critical', high: 'critical', medium: 'warning', low: 'muted',
  // cameras
  online: 'good', paused: 'muted', not_on_gateway: 'muted', offline: 'warning',
  not_working: 'critical', connecting: 'warning', not_connected: 'muted',
  // live labels
  lying: 'critical', falling: 'warning', upright: 'good',
};

/** Colored badge that always carries its text label (status color is never the only cue). */
export function StatusBadge({ value, label }: { value: string; label?: string }) {
  const text = label ?? STATUS_TEXT[value] ?? value.charAt(0).toUpperCase() + value.slice(1);
  return <span className={`badge badge--${TONE[value] ?? 'muted'}`}>{text}</span>;
}
