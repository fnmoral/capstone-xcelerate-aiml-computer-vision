import { PageHeader } from '../../components/ui/PageHeader';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { api } from '../../services/api/fallguard';
import { usePolling } from '../../services/api/usePolling';
import { formatDuration } from '../../lib/format';
import { PersonConfidence } from './PersonConfidence';

const RULES: { key: string; label: string; unit: string; help: string }[] = [
  { key: 'lying_torso_angle_deg', label: 'Lying: torso angle', unit: '°', help: 'Torso this far from vertical counts fully as lying' },
  { key: 'lying_aspect_ratio', label: 'Lying: box shape', unit: '× wider than tall', help: 'A person this much wider than tall looks like lying' },
  { key: 'falling_torso_angle_deg', label: 'Falling: minimum tilt', unit: '°', help: 'Torso tilt needed for the "falling" label' },
  { key: 'fall_velocity', label: 'Falling: hip drop speed', unit: 'frame heights/s', help: 'How fast the hips must drop' },
  { key: 'min_keypoint_conf', label: 'Body-point confidence', unit: '', help: 'Body points below this are ignored' },
];

const TIMINGS: { key: string; label: string; help: string }[] = [
  { key: 'confirm_seconds', label: 'Confirm a fall after', help: 'Someone must stay down this long before an alert' },
  { key: 'recover_seconds', label: 'Recovered after', help: 'Standing this long closes the incident' },
  { key: 'high_after_seconds', label: 'Severity high after', help: 'Still down after this long' },
  { key: 'critical_after_seconds', label: 'Severity critical after', help: 'Still down after this long' },
  { key: 'lost_track_seconds', label: 'Out of view for', help: 'Then the incident is "unresolved": someone should check' },
  { key: 'merge_window_seconds', label: 'Zone merge window', help: 'Falls seen by several cameras of a zone within this time are one alert' },
];

/** Same column widths in the Labels and Incidents tables, so their columns line up. */
function SettingsCols() {
  return <colgroup><col className="col-setting" /><col className="col-value" /><col /></colgroup>;
}

export default function DetectionPage() {
  const { data: d, error, reload } = usePolling(() => api.detection(), 5000);
  const { data: cams } = usePolling(() => api.cameras(), 15000);
  const names = Object.fromEntries((cams?.cameras ?? []).map((c) => [c.id, c.name]));

  return (
    <>
      <PageHeader title="Detection Settings"
        description="How the fall detector decides. Minimum person confidence can be changed here; the rest comes from ml-service's config.yaml (see ml-service/CONFIG.md)." />
      {error && <p className="notice notice--error">{error}</p>}
      {!d ? <p className="muted">Loading…</p> : (
        <div className="stack">
          <div className="tiles">
            <div className="tile card"><div className="tile__label">Model</div><div className="tile__value" style={{ fontSize: 18 }}>{d.model}</div>
              <div className="tile__hint">YOLO26 pose + fall rules</div></div>
            <div className="tile card"><div className="tile__label">Analysis rate (actual)</div>
              <div className="tile__value">{d.analysis?.average_fps ?? '—'}</div>
              <div className="tile__hint">
                {d.analysis?.average_fps == null ? 'no camera sending video' : 'frames per second, average per camera, last 30 s'}
                {' · '}target {d.target_fps}</div></div>
            <div className="tile card"><div className="tile__label">Device in use</div>
              <div className="tile__value" style={{ fontSize: 18 }}>{d.device_in_use ?? 'Starting…'}</div>
              <div className="tile__hint">config: {d.device === 'auto' ? 'auto (GPU if available)' : d.device} · mode: {d.mode}</div></div>
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

          <PersonConfidence key={String(d.saved.person_confidence)} d={d} onSaved={reload} />

          <section className="card" style={{ padding: 16 }}>
            <h2 className="section-title">Labels</h2>
            <p className="row"><StatusBadge value="upright" /> standing, walking or sitting
              <StatusBadge value="falling" /> going down fast <StatusBadge value="lying" /> on the floor</p>
            <div className="table-wrap"><table className="table table--settings">
              <SettingsCols />
              <thead><tr><th>Rule</th><th className="num">Value</th><th>Meaning</th></tr></thead>
              <tbody>{RULES.map((r) => (
                <tr key={r.key}><td>{r.label}</td><td className="num">{d.rules[r.key]} {r.unit}</td><td className="muted">{r.help}</td></tr>
              ))}</tbody>
            </table></div>
          </section>

          <section className="card" style={{ padding: 16 }}>
            <h2 className="section-title">Incidents and alerts</h2>
            <div className="table-wrap"><table className="table table--settings">
              <SettingsCols />
              <thead><tr><th>Setting</th><th className="num">Value</th><th>Meaning</th></tr></thead>
              <tbody>{TIMINGS.map((t) => (
                <tr key={t.key}><td>{t.label}</td><td className="num">{formatDuration(d.incidents[t.key])}</td><td className="muted">{t.help}</td></tr>
              ))}</tbody>
            </table></div>
          </section>

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
