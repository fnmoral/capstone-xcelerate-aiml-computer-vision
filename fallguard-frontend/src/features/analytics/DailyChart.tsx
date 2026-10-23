import { useState } from 'react';

interface Day { day: string; count: number }

const W = 640, H = 220, PAD = { top: 16, right: 12, bottom: 28, left: 32 };

/**
 * Incidents per day (single series, so one hue and no legend; the title names it).
 * Bars: 4px rounded top anchored to the baseline, 2px gaps, recessive grid,
 * hover/focus tooltip per bar, and a table view for screen readers and exact values.
 */
export function DailyChart({ days }: { days: Day[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...days.map((d) => d.count));
  const step = max <= 4 ? 1 : Math.ceil(max / 4);
  const top = Math.ceil(max / step) * step;
  const ticks = Array.from({ length: top / step + 1 }, (_, i) => i * step);
  const plotW = W - PAD.left - PAD.right, plotH = H - PAD.top - PAD.bottom;
  const slot = plotW / Math.max(1, days.length);
  const barW = Math.max(2, slot - 2); // 2px gap between bars
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
  // day is a local date (YYYY-MM-DD) from the API; format it as that date, not as a moment.
  const label = (day: string) => new Date(day + 'T00:00:00Z').toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' });

  return (
    <figure className="chart">
      <div className="chart__plot">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Fall incidents per day, last ${days.length} days`}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} className="chart__grid" />
              <text x={PAD.left - 6} y={y(t)} className="chart__axis" textAnchor="end" dominantBaseline="middle">{t}</text>
            </g>
          ))}
          {days.map((d, i) => {
            const x = PAD.left + i * slot + 1;
            const h = Math.max(0, y(0) - y(d.count));
            const r = Math.min(4, barW / 2, h);
            return (
              <g key={d.day} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(i)} onBlur={() => setHover(null)} tabIndex={0}
                aria-label={`${label(d.day)}: ${d.count} incident${d.count === 1 ? '' : 's'}`}>
                {/* Hit target taller and wider than the bar */}
                <rect x={x - 1} y={PAD.top} width={slot} height={plotH} fill="transparent" />
                {h > 0 && (
                  <path className={`chart__bar${hover === i ? ' chart__bar--hover' : ''}`}
                    d={`M${x},${y(0)} V${y(d.count) + r} Q${x},${y(d.count)} ${x + r},${y(d.count)}
                        H${x + barW - r} Q${x + barW},${y(d.count)} ${x + barW},${y(d.count) + r} V${y(0)} Z`} />
                )}
                {(i % Math.ceil(days.length / 7) === 0 || i === days.length - 1) && (
                  <text x={x + barW / 2} y={H - 8} className="chart__axis" textAnchor="middle">{label(d.day)}</text>
                )}
              </g>
            );
          })}
          <line x1={PAD.left} x2={W - PAD.right} y1={y(0)} y2={y(0)} className="chart__baseline" />
        </svg>
        {hover !== null && (
          <div className="chart__tip" style={{ left: `${((PAD.left + hover * slot + slot / 2) / W) * 100}%` }}>
            <strong>{days[hover].count}</strong> incident{days[hover].count === 1 ? '' : 's'}
            <span>{label(days[hover].day)}</span>
          </div>
        )}
      </div>
      <details className="chart__table">
        <summary>Show as table</summary>
        <table className="table">
          <thead><tr><th>Day</th><th className="num">Incidents</th></tr></thead>
          <tbody>{days.map((d) => <tr key={d.day}><td>{label(d.day)}</td><td className="num">{d.count}</td></tr>)}</tbody>
        </table>
      </details>
    </figure>
  );
}
