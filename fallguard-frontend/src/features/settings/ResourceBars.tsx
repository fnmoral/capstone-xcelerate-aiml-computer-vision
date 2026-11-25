import type { Resources } from '../../types/domain';

const GB = 1e9;
/** 512 MB, 1.4 GB, 32 GB */
const size = (bytes: number) =>
  bytes < GB ? `${Math.round(bytes / 1e6)} MB` : `${(bytes / GB).toFixed(bytes >= 10 * GB ? 0 : 1)} GB`;

/** One "used of total" bar: green, then amber from 75%, red from 90%. */
function Bar({ label, used, total, hint }: { label: string; used: number; total: number; hint?: string }) {
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const level = pct >= 90 ? 'danger' : pct >= 75 ? 'warn' : 'ok';
  return (
    <div className="res">
      <div className="res__head">
        <span>{label}</span>
        <span className="muted"><strong className={`res__pct res__pct--${level}`}>{pct}%</strong> · {size(used)} of {size(total)} used</span>
      </div>
      <div className="res__track" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}
        aria-valuetext={`${pct}% used, ${size(used)} of ${size(total)}`}>
        <div className={`res__fill res__fill--${level}`} style={{ width: `${pct}%` }} />
      </div>
      {hint && <p className="res__hint muted">{hint}</p>}
    </div>
  );
}

/** Server memory, disk and incident videos (Settings → System status). */
export function ResourceBars({ r }: { r?: Resources }) {
  if (!r || (!r.memory && !r.disk && !r.videos)) return null;
  const v = r.videos;
  const memPct = r.memory ? r.memory.used / r.memory.total : 0;
  const diskPct = r.disk ? r.disk.used / r.disk.total : 0;
  const videoLimit = v && v.max_total_gb > 0 ? v.max_total_gb * GB : 0;
  return (
    <div className="res-list">
      {r.memory && (
        <Bar label="Memory (RAM)" used={r.memory.used} total={r.memory.total}
          hint={memPct >= 0.9 ? 'Nearly full: the server may slow down or restart services. Consider a larger server.' : undefined} />
      )}
      {r.disk && (
        <Bar label="Storage (database and videos)" used={r.disk.used} total={r.disk.total}
          hint={diskPct >= 0.75 ? 'Filling up: keep videos for fewer days, or add disk space.' : undefined} />
      )}
      {v && (videoLimit > 0 ? (
        <Bar label="Incident videos" used={v.clip_bytes} total={videoLimit}
          hint={`${v.clips} video${v.clips === 1 ? '' : 's'}. Kept ${v.retention_days > 0 ? `${v.retention_days} days` : 'until removed'}; above ${v.max_total_gb} GB the oldest are deleted first.`} />
      ) : (
        <p className="res__hint muted">Incident videos: {size(v.clip_bytes)} in {v.clips} video{v.clips === 1 ? '' : 's'}
          {v.retention_days > 0 ? `, kept ${v.retention_days} days` : ''}.</p>
      ))}
    </div>
  );
}
