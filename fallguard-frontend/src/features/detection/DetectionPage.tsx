import { PageHeader } from '../../components/ui/PageHeader';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { api } from '../../services/api/fallguard';
import { usePolling } from '../../services/api/usePolling';
import { formatDuration } from '../../lib/format';
import { PersonConfidence } from './PersonConfidence';
import { DetectionRules } from './DetectionRules';
import { ModelDevice } from './ModelDevice';
import { PERM, useAuth } from '../auth/AuthContext';

export default function DetectionPage() {
  const canChange = useAuth().can(PERM.manageDetection);
  const { data: d, error, reload } = usePolling(() => api.detection(), 5000);
  const { data: cams } = usePolling(() => api.cameras(), 15000);
  const names = Object.fromEntries((cams?.cameras ?? []).map((c) => [c.id, c.name]));

  return (
    <>
      <PageHeader title="Detection Settings"
        description="How the fall detector decides. The model, device and minimum person confidence can be changed here; the rules below are this organization's (a super admin can change them)." />
      {error && <p className="notice notice--error">{error}</p>}
      {!d ? <p className="muted">Loading…</p> : (
        <div className="stack">
          <div className="tiles">
            <div className="tile card"><div className="tile__label">Model</div><div className="tile__value" style={{ fontSize: 18 }}>{d.model}</div>
              <div className="tile__hint">{d.saved.model ? 'set below' : 'default'} · pose model + fall rules</div></div>
            <div className="tile card"><div className="tile__label">Analysis rate (actual)</div>
              <div className="tile__value">{d.analysis?.average_fps ?? '—'}</div>
              <div className="tile__hint">
                {d.analysis?.average_fps == null ? 'no camera sending video' : 'frames per second, average per camera, last 30 s'}
                {' · '}target {d.target_fps}</div></div>
            <div className="tile card"><div className="tile__label">Device in use</div>
              <div className="tile__value" style={{ fontSize: 18 }}>{d.device_in_use ?? 'Starting…'}</div>
              <div className="tile__hint">{d.saved.device ? `set below: ${d.saved.device}` : `config: ${d.device === 'auto' ? 'auto (GPU if available)' : d.device}`} · mode: {d.mode}</div></div>
            <div className="tile card"><div className="tile__label">Person confidence</div><div className="tile__value">{d.person_confidence}</div>
              <div className="tile__hint">{d.saved.person_confidence !== undefined ? 'set below' : 'default'}</div></div>
          </div>

          {(d.analysis?.cameras.length ?? 0) > 0 && (
            <section className="card" style={{ padding: 16 }}>
              <h2 className="section-title">Analysis rate per camera</h2>
              <div className="table-wrap"><table className="table">
                <thead><tr><th>Camera</th><th className="num">Video received</th><th className="num">Analysed</th><th>Meaning</th></tr></thead>
                <tbody>{d.analysis.cameras.map((c) => (
                  <tr key={c.camera_id}>
                    <td>{names[c.camera_id] ?? c.camera_id}</td>
                    <td className="num">{c.received_fps} fps</td>
                    <td className="num">{c.analysed_fps} fps</td>
                    <td className="muted">{c.received_fps === 0 ? 'no video arriving'
                      : c.analysed_fps < Math.min(d.target_fps, c.received_fps) * 0.8
                        ? "below target: the model can't keep up (too many cameras, or running on the CPU)"
                        : c.received_fps < d.target_fps ? 'OK (the camera sends fewer frames than the target)' : 'OK'}</td>
                  </tr>
                ))}</tbody>
              </table></div>
              <p className="muted" style={{ marginBottom: 0, fontSize: 13 }}>
                The model looks at up to {d.target_fps} frames per second per camera; a camera sending fewer is analysed at its own rate.
              </p>
            </section>
          )}

          <fieldset disabled={!canChange} className="detection-edit" style={{ border: 0, padding: 0, margin: 0, minWidth: 0, display: 'grid', gap: 20 }}>
            {!canChange && <p className="notice" style={{ margin: 0 }}>View only: your role can't change detection settings.</p>}
            <ModelDevice key={`${d.saved.model}|${d.saved.device}`} d={d} onSaved={reload} />
            <PersonConfidence key={String(d.saved.person_confidence)} d={d} onSaved={reload} />
          </fieldset>

          <section className="card" style={{ padding: 16 }}>
            <h2 className="section-title">Labels</h2>
            <p className="row" style={{ margin: 0 }}><StatusBadge value="upright" /> standing, walking or sitting
              <StatusBadge value="falling" /> going down fast <StatusBadge value="lying" /> on the floor <StatusBadge value="unclear" /> too little visible to tell</p>
          </section>

          <DetectionRules mergeWindow={d.incidents?.merge_window_seconds} />

          <section className="card" style={{ padding: 16 }}>
            <h2 className="section-title">Zones in use</h2>
            {Object.keys(d.zones).length === 0 ? <p className="muted">No zones. Set one on a camera in Cameras.</p> : (
              <ul>{Object.entries(d.zones).map(([z, cams]) => (
                <li key={z}><strong>{z}</strong> <span className="muted">· {new Set(cams).size} camera reference(s)</span></li>
              ))}</ul>
            )}
            <p className="muted" style={{ marginBottom: 0 }}>Zone changes made in Cameras are picked up within 15 seconds.</p>
          </section>

          {d.clips && (
            <section className="card" style={{ padding: 16 }}>
              <h2 className="section-title">Incident video clips</h2>
              {!d.clips.enabled ? <p className="muted">Off (clips.enabled in config.yaml).</p> : (
                <p style={{ margin: 0 }}>
                  Like a dashcam: each camera keeps the last {d.clips.pre_roll_s} s of video in memory. A confirmed fall
                  saves that, plus everything until {d.clips.post_roll_s} s after the person is back up or out of view
                  (at most {formatDuration(d.clips.max_s)}), as an MP4 up to {d.clips.max_width} px wide. Clips are
                  deleted after {d.clips.retention_days} days, or the oldest first above {d.clips.max_total_gb} GB.
                </p>
              )}
            </section>
          )}
        </div>
      )}
    </>
  );
}
