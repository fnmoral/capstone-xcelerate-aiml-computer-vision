import { useEffect, useState } from 'react';
import { appTimeZone } from '../../lib/format';
import { useUiStore } from '../../store/uiStore';

/**
 * Current date and time in the app's time zone (Settings), at the bottom of the sidebar.
 * Full date and time when the sidebar is open; just the time on the collapsed rail.
 */
export function SidebarClock({ collapsed }: { collapsed: boolean }) {
  useUiStore((s) => s.timeZone); // re-render when the facility time zone changes
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const timeZone = appTimeZone();
  const time = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', ...(collapsed ? {} : { second: '2-digit' }), timeZone });
  const date = now.toLocaleDateString([], collapsed
    ? { month: 'short', day: 'numeric', timeZone }
    : { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone });
  const zone = now.toLocaleTimeString([], { timeZoneName: 'short', timeZone }).split(' ').pop();

  return (
    <div className={`nav-clock${collapsed ? ' nav-clock--rail' : ''}`} title={`${date} · ${time} (${timeZone})`}>
      <time dateTime={now.toISOString()} className="nav-clock__time">{time}</time>
      <span className="nav-clock__date">{date}</span>
      {!collapsed && <span className="nav-clock__zone">{timeZone.replace(/_/g, ' ')} · {zone}</span>}
    </div>
  );
}
