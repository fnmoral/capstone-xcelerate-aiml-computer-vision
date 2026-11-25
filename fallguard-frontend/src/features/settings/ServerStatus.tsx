import { StatusBadge } from '../../components/ui/StatusBadge';
import type { Resources } from '../../types/domain';

const GB = 1e9;
/** 512 MB, 1.4 GB, 32 GB */
const size = (bytes: number) =>
  bytes < GB ? `${Math.max(0, Math.round(bytes / 1e6))} MB` : `${(bytes / GB).toFixed(bytes >= 10 * GB ? 0 : 1)} GB`;
const level = (pct: number) => (pct >= 90 ? 'danger' : pct >= 75 ? 'warn' : '');
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

interface Part { key: string; label: string; bytes: number }

/** A thin bar split into parts (each a share of total), with the rest left empty. */
function Track({ label, parts, total, warn }: { label: string; parts: Part[]; total: number; warn: string }) {
  const used = parts.reduce((a, p) => a + p.bytes, 0);
  const pct = total > 0 ? Math.round((used / total) * 100) : 0;
  return (
    <div className="srv__track" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}
      aria-valuetext={`${pct}% used: ${parts.map((p) => `${p.label} ${size(p.bytes)}`).join(', ')}, of ${size(total)}`}>
      {parts.map((p) => (
        <span key={p.key} className={`srv__seg srv__seg--${warn || p.key}`} style={{ width: `${total > 0 ? (p.bytes / total) * 100 : 0}%` }} />
      ))}
    </div>
  );
}

/**
 * The server row of Settings → System status (where it runs, e.g. Azure), with its memory and
 * storage underneath: storage split into the database, incident videos and photos, and the rest.
 */
export function ServerRows({ r }: { r?: Resources }) {
  if (!r || (!r.memory && !r.disk)) return null;
  const mem = r.memory;
  const disk = r.disk;
  const memPct = mem ? Math.round((mem.used / mem.total) * 100) : 0;
  const diskPct = disk ? Math.round((disk.used / disk.total) * 100) : 0;
  const v = r.videos;
  const media = v ? v.clip_bytes + v.snapshot_bytes : 0;
  const db = r.database_bytes ?? 0;
  const parts: Part[] = disk ? [
    { key: 'db', label: 'Database', bytes: db },
    { key: 'media', label: 'Videos & photos', bytes: media },
    { key: 'other', label: 'Other', bytes: Math.max(0, disk.used - db - media) },
  ] : [];
  const hints = [
    memPct >= 90 && 'Memory is nearly full: consider a larger server.',
    diskPct >= 75 && 'Storage is filling up: keep videos for fewer days, or add disk space.',
  ].filter(Boolean);

  return (
    <>
      <tr className="srv-row">
        <td>Server ({r.hosting || 'On-premises'})</td>
        <td><StatusBadge value="online" label="Running" /></td>
        <td />
      </tr>
      <tr className="srv-detail">
        <td colSpan={3}>
          <div className="srv">
            {mem && (
              <div className="srv__item">
                <div className="srv__head">
                  <span>Memory</span>
                  <span className="muted"><strong className={`srv__pct srv__pct--${level(memPct)}`}>{memPct}%</strong> · {size(mem.used)} of {size(mem.total)}</span>
                </div>
                <Track label="Memory" parts={[{ key: 'mem', label: 'Used', bytes: mem.used }]} total={mem.total} warn={level(memPct)} />
              </div>
            )}
            {disk && (
              <div className="srv__item">
                <div className="srv__head">
                  <span>Storage</span>
                  <span className="muted"><strong className={`srv__pct srv__pct--${level(diskPct)}`}>{diskPct}%</strong> · {size(disk.used)} of {size(disk.total)}</span>
                </div>
                <Track label="Storage" parts={parts} total={disk.total} warn={level(diskPct)} />
                <ul className="srv__legend">
                  {parts.map((p) => (
                    <li key={p.key}><span className={`srv__dot srv__seg--${p.key}`} aria-hidden="true" />{p.label} {size(p.bytes)}</li>
                  ))}
                  <li><span className="srv__dot srv__dot--free" aria-hidden="true" />Free {size(disk.total - disk.used)}</li>
                </ul>
              </div>
            )}
          </div>
          {v && (
            <p className="srv__note muted">
              {plural(v.clips, 'video')} and {plural(v.snapshots, 'photo')} of falls.
              {v.retention_days > 0 && ` Videos are kept ${v.retention_days} days`}
              {v.max_total_gb > 0 && `${v.retention_days > 0 ? ';' : ' Videos:'} above ${v.max_total_gb} GB the oldest are deleted first`}.
            </p>
          )}
          {hints.map((h) => <p key={String(h)} className="srv__note srv__note--warn">{h}</p>)}
        </td>
      </tr>
    </>
  );
}
