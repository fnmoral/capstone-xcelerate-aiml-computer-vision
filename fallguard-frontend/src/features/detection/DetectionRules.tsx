import { useCallback, useEffect, useState } from 'react';
import { api } from '../../services/api/fallguard';
import type { DetectionRules as Rules, RuleField } from '../../types/domain';
import { formatDuration } from '../../lib/format';
import { useAuth } from '../auth/AuthContext';

/** What each rule means. seconds = shown as a duration. */
/** unit: shown with read-only values; short: the unit inside an edit box (the Meaning column explains it). */
const INFO: Record<string, { label: string; unit?: string; short?: string; seconds?: boolean; help: string }> = {
  confirm_seconds: { label: 'Confirm a fall after', seconds: true, help: 'Someone must stay down this long before it counts as a fall and alerts go out' },
  recover_seconds: { label: 'Recovered after', seconds: true, help: 'Standing this long closes the fall event as recovered' },
  lying_torso_angle_deg: { label: 'Lying: torso angle', unit: '°', help: 'Torso this far from vertical counts fully as lying' },
  falling_torso_angle_deg: { label: 'Falling: minimum tilt', unit: '°', help: 'Torso tilt needed for the "falling" label (smaller than the lying angle)' },
  lying_aspect_ratio: { label: 'Lying: box shape', unit: '× wider than tall', short: '× wide', help: 'A person this much wider than tall looks like lying' },
  fall_velocity: { label: 'Falling: hip drop speed', unit: 'torso lengths/s', short: 'len/s', help: 'How fast the hips must drop, measured in body size so near and far look the same' },
  high_after_seconds: { label: 'Severity High after', seconds: true, help: 'Still down this long: the alert rises from Medium to High' },
  critical_after_seconds: { label: 'Severity Critical after', seconds: true, help: 'Still down this long: the alert rises to Critical (later than High)' },
  lost_track_seconds: { label: 'Out of view for', seconds: true, help: 'Then they are forgotten. A fall last seen at the edge of the picture becomes "unresolved" (out of view)' },
  confirm_ratio: { label: 'Confirm: share of frames down', help: 'Share of frames in the confirm time that must show the person down (0.5–1)' },
  standing_legs: { label: 'Standing: legs under hips', help: 'Legs this straight under the hips mean standing or bending, never lying (0–1)' },
  min_visible_keypoints: { label: 'Body points needed', unit: 'of 17', help: 'Fewer visible points (or no hips/legs) gives "unclear" instead of a guess' },
  min_keypoint_conf: { label: 'Body-point confidence', help: 'Body points the model is less sure of than this are ignored' },
  handoff_seconds: { label: 'Same person if renumbered within', seconds: true, help: 'A new tracker number where someone was just lost carries on their fall' },
  handoff_radius: { label: 'Renumbered: distance', unit: '× box size', short: '× box', help: 'How close the new number must appear to count as the same person' },
  handoff_incident_radius: { label: 'Renumbered: distance (fall in progress)', unit: '× box size', short: '× box', help: 'The same, for someone whose fall is open (checked first)' },
};

const GROUPS: { key: RuleField['group']; title: string }[] = [
  { key: 'fall', title: 'Fall rules' },
  { key: 'alerts', title: 'Alert timing' },
];

const show = (key: string, v: number) => {
  const i = INFO[key];
  return i?.seconds ? formatDuration(v) : `${v}${i?.unit ? ` ${i.unit}` : ''}`;
};

/**
 * This organization's fall and alert rules. Everyone sees them; super admins change them
 * (for this organization only) and can restore the detector's defaults.
 */
export function DetectionRules({ mergeWindow }: { mergeWindow?: number }) {
  const { me } = useAuth();
  const [data, setData] = useState<Rules | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false); // super admins: the boxes are open

  const load = useCallback(async () => {
    const r = await api.detectionRules();
    setData(r);
    setDraft(Object.fromEntries(r.fields.map((f) => [f.key, String(r.saved[f.key] ?? r.defaults[f.key])])));
  }, []);
  useEffect(() => { load().catch((e) => setError(e instanceof Error ? e.message : String(e))); }, [load]);

  if (!data) {
    return (
      <section className="card" style={{ padding: 16 }}>
        <h2 className="section-title">Detection rules</h2>
        {error ? <p className="notice notice--error">{error}</p> : <p className="muted">Loading…</p>}
      </section>
    );
  }

  const value = (k: string) => data.saved[k] ?? data.defaults[k];
  const edit = data.can_edit && editing;
  const changed = Object.keys(data.saved).length;
  const dirty = data.fields.some((f) => Number(draft[f.key]) !== value(f.key));

  const save = async (rules: Record<string, number> | null) => {
    setError(null);
    setNotice(null);
    let body: Record<string, number> = {};
    if (rules === null) { // from the form
      for (const f of data.fields) {
        const n = Number(draft[f.key]);
        if (draft[f.key].trim() === '' || Number.isNaN(n) || n < f.min || n > f.max) {
          setError(`${INFO[f.key]?.label ?? f.key}: enter a number from ${f.min} to ${f.max}.`);
          return;
        }
        if (n !== data.defaults[f.key]) body[f.key] = n;
      }
    } else body = rules;
    setSaving(true);
    try {
      await api.saveDetectionRules(body);
      await load();
      setEditing(false);
      setNotice(Object.keys(body).length ? 'Saved. The detector uses the new rules within 15 seconds.' : 'Defaults restored. The detector uses them within 15 seconds.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const rows = (group: RuleField['group']) => data.fields.filter((f) => f.group === group).map((f) => {
    const info = INFO[f.key];
    const isChanged = f.key in data.saved;
    return (
      <tr key={f.key}>
        <td>{info?.label ?? f.key}{isChanged && <span className="badge rules__changed">changed</span>}</td>
        <td className={edit ? 'rules__value' : 'num'}>
          {edit ? (
            <label className={`rules__input${Number(draft[f.key]) !== data.defaults[f.key] ? ' is-changed' : ''}`}
              title={`${f.min} to ${f.max}${info?.seconds ? ' seconds' : ''}`}>
              <input type="number" inputMode="decimal" min={f.min} max={f.max} step={f.step} value={draft[f.key]} disabled={saving}
                aria-label={info?.label ?? f.key} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} />
              <span className="rules__unit">{info?.seconds ? 's' : info?.short ?? info?.unit ?? ''}</span>
            </label>
          ) : show(f.key, value(f.key))}
        </td>
        <td className="muted">{info?.help}{isChanged && <> · default {show(f.key, data.defaults[f.key])}</>}</td>
      </tr>
    );
  });

  const table = (group: RuleField['group']) => (
    <div className="table-wrap"><table className="table table--settings">
      <colgroup><col className="col-setting" /><col className="col-value" /><col /></colgroup>
      <thead><tr><th>Rule</th><th className="num">Value</th><th>Meaning</th></tr></thead>
      <tbody>{rows(group)}</tbody>
    </table></div>
  );

  return (
    <section className="card rules" style={{ padding: 16 }}>
      <div className="rules__head">
        <h2 className="section-title" style={{ margin: 0 }}>Detection rules</h2>
        <span className="rules__head-end">
          <span className="muted">{changed ? `${changed} changed for ${me?.org.name ?? 'this organization'}` : 'Defaults'}</span>
          {data.can_edit && !editing && (
            <button className="btn btn--sm" onClick={() => { setNotice(null); setError(null); setEditing(true); }}>Edit rules</button>
          )}
        </span>
      </div>
      <p className="muted" style={{ marginTop: 6 }}>
        {edit
          ? `These rules apply to ${me?.org.name ?? 'this organization'} only. People already being watched carry on with the new values.`
          : data.can_edit
            ? `How the detector decides a fall and when alerts rise, for ${me?.org.name ?? 'this organization'}. Use Edit rules to change them.`
            : 'How the detector decides a fall and when alerts rise. Only a FallGuard super admin can change them.'}
      </p>
      {error && <p className="notice notice--error">{error}</p>}
      {notice && <p className="notice" role="status">{notice}</p>}
      {GROUPS.map((g) => (
        <div key={g.key} className="rules__group">
          <h3 className="rules__title">{g.title}</h3>
          {table(g.key)}
        </div>
      ))}
      {mergeWindow !== undefined && (
        <p className="muted" style={{ fontSize: 13 }}>
          Zone merge window: {formatDuration(mergeWindow)} (falls seen by several cameras of a zone within this time are one alert; the same for every organization).
        </p>
      )}
      <details className="rules__group">
        <summary>Advanced rules</summary>
        {table('advanced')}
      </details>
      {edit && (
        <div className="row rules__actions">
          <button className="btn btn--primary" disabled={saving || !dirty} onClick={() => void save(null)}>{saving ? 'Saving…' : 'Save rules'}</button>
          <button className="btn" disabled={saving} onClick={() => { setError(null); void load().then(() => setEditing(false)); }}>Cancel</button>
          <button className="btn" disabled={saving || changed === 0}
            onClick={() => confirm('Restore every rule to the default for this organization?') && void save({})}>
            Restore defaults
          </button>
        </div>
      )}
    </section>
  );
}
