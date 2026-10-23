import { useRef, useState } from 'react';
import { clipUrl, snapshotUrl } from '../../services/api/fallguard';
import { formatTime, secondsSince, shortId } from '../../lib/format';
import type { Incident } from '../../types/domain';
import { Snapshot } from './Snapshot';

/** A clip is saved post_roll (10 s) after the person is up, then encoded: allow a minute. */
const STILL_SAVING_S = 60;

interface Clip {
  cameraId: string;
  name: string;
  key: string;
  poster: string | null;
}

function clipsOf(inc: Incident): Clip[] {
  const seen = new Set<string>();
  const out: Clip[] = [];
  for (const c of inc.cameras) {
    if (c.clip_key && !seen.has(c.camera_id)) {
      seen.add(c.camera_id);
      out.push({ cameraId: c.camera_id, name: c.camera_name ?? shortId(c.camera_id), key: c.clip_key, poster: c.snapshot_key });
    }
  }
  if (out.length === 0 && inc.clip_key) {
    out.push({ cameraId: inc.camera_id, name: inc.camera_name ?? shortId(inc.camera_id), key: inc.clip_key, poster: inc.snapshot_key });
  }
  return out;
}

function Player({ clip, big, refFn }: { clip: Clip; big?: boolean; refFn?: (v: HTMLVideoElement | null) => void }) {
  return (
    <figure className={`ev-video${big ? ' ev-video--big' : ''}`}>
      <video ref={refFn} src={clipUrl(clip.key)} poster={clip.poster ? snapshotUrl(clip.poster) : undefined}
        controls preload="metadata" playsInline muted aria-label={`Video of the fall from ${clip.name}`} />
      <figcaption className="muted">
        {clip.name} · <a href={clipUrl(clip.key)} download>Download</a>
      </figcaption>
    </figure>
  );
}

/** The incident's video: one camera full size; several side by side or one at a time. */
export function IncidentVideos({ inc }: { inc: Incident }) {
  const clips = clipsOf(inc);
  const [mode, setMode] = useState<'all' | 'one'>('all');
  const [current, setCurrent] = useState(0);
  const players = useRef<(HTMLVideoElement | null)[]>([]);

  if (clips.length === 0) {
    const endedAgo = inc.recovered_at ? secondsSince(inc.recovered_at) : null;
    const saving = inc.status === 'active' || (endedAgo !== null && endedAgo < STILL_SAVING_S)
      || (inc.status === 'unresolved' && secondsSince(inc.started_at) < 180);
    const photos = inc.cameras.filter((c) => c.snapshot_key);
    return (
      <>
        <p className={`notice${saving ? '' : ' muted'}`}>
          {saving
            ? 'Recording video… The clip appears here about 10 seconds after the person is back up or out of view.'
            : 'No video for this incident (recorded before clips existed, or the camera does not stream through the gateway). Photo shown instead.'}
        </p>
        <div className="ev-photos">
          {(photos.length ? photos : [{ camera_id: inc.camera_id, camera_name: inc.camera_name, track_id: 0, joined_at: inc.started_at, snapshot_key: inc.snapshot_key }])
            .map((p) => (
              <figure key={p.camera_id + p.track_id}>
                <Snapshot snapshotKey={p.snapshot_key} className="ev-photo" alt={`Moment the fall was confirmed on ${p.camera_name ?? 'camera'}`} />
                <figcaption className="muted">{p.camera_name ?? shortId(p.camera_id)} · {formatTime(p.joined_at)}</figcaption>
              </figure>
            ))}
        </div>
      </>
    );
  }

  if (clips.length === 1) return <Player clip={clips[0]} big />;

  const playAll = () => players.current.forEach((v) => { if (v) { v.currentTime = 0; void v.play(); } });
  const shown = clips[Math.min(current, clips.length - 1)];
  return (
    <>
      <div className="row ev-video-bar">
        <div className="tabs" role="group" aria-label="How to show the cameras">
          <button className="tab" aria-pressed={mode === 'all'} onClick={() => setMode('all')}>All at once</button>
          <button className="tab" aria-pressed={mode === 'one'} onClick={() => setMode('one')}>One at a time</button>
        </div>
        {mode === 'all' ? (
          <button className="btn btn--sm" onClick={playAll}>Play all from the start</button>
        ) : (
          <div className="live-chips" role="group" aria-label="Camera">
            {clips.map((c, i) => (
              <button key={c.cameraId} className="live-chip" aria-pressed={c === shown} onClick={() => setCurrent(i)}>{c.name}</button>
            ))}
          </div>
        )}
      </div>
      {mode === 'all' ? (
        <div className="ev-video-grid">
          {clips.map((c, i) => <Player key={c.cameraId} clip={c} refFn={(v) => { players.current[i] = v; }} />)}
        </div>
      ) : (
        <Player key={shown.cameraId} clip={shown} big />
      )}
    </>
  );
}
