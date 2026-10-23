import { useState } from 'react';
import { snapshotUrl } from '../../services/api/fallguard';

/** Incident photo that falls back to a neutral placeholder if the file is missing. */
export function Snapshot({ snapshotKey, className, alt = '' }: { snapshotKey: string | null; className?: string; alt?: string }) {
  const [failed, setFailed] = useState(false);
  if (!snapshotKey || failed) {
    return <span className={`${className ?? ''} ev-nophoto`} aria-label={alt ? 'No photo' : undefined}>No photo</span>;
  }
  return <img className={className} src={snapshotUrl(snapshotKey)} alt={alt} loading="lazy" onError={() => setFailed(true)} />;
}
