import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { Icon } from '../../components/ui/Icon';
import { incidentReports, type ReportForm } from '../../services/api/accounts';
import { usePolling } from '../../services/api/usePolling';
import { formatTime } from '../../lib/format';
import { PERM, useAuth } from '../auth/AuthContext';
import { autoFill, carryOver, FORMS, formById } from './forms';
import './reports.css';

/** Incident page section: this incident's reports, and starting a new one from a form. */
export function IncidentReportsPanel({ incidentId }: { incidentId: string }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const { data, error } = usePolling(() => incidentReports.list(incidentId), 30000, [incidentId]);
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState<ReportForm | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  const create = async (form: ReportForm) => {
    setBusy(form);
    setCreateError(null);
    try {
      const def = formById(form)!;
      // Earlier reports supply what people already typed (the same person, the employer...).
      const [facts, earlier] = await Promise.all([
        incidentReports.facts(incidentId),
        incidentReports.list().then((r) => r.reports).catch(() => []),
      ]);
      const { fields, auto, from } = carryOver(def, incidentId, autoFill(def, facts), earlier);
      const { report } = await incidentReports.create(incidentId, {
        form, title: `${def.short}: ${facts.incident.camera_name ?? 'fall'} ${fields.accident_date ?? fields.incident_date ?? fields.injury_date ?? fields.occurrence_date ?? ''}`.trim(),
        content: { fields, auto, from, facts_at: facts.generated_at },
      });
      navigate(`/incident-reports/${report.id}`);
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };

  const reports = data?.reports ?? [];
  return (
    <>
      {error && <p className="notice notice--error">{error}</p>}
      {reports.length === 0 ? <p className="muted">No reports yet.</p> : (
        <ul className="ev-list">
          {reports.map((r) => (
            <li key={r.id}>
              <Link to={`/incident-reports/${r.id}`}><strong>{formById(r.form)?.short ?? r.form}</strong></Link>{' '}
              <StatusBadge value={r.status === 'final' ? 'resolved' : 'acknowledged'} label={r.status === 'final' ? 'Final' : 'Draft'} />
              <div className="muted ev-sub">{r.created_by ?? 'Someone'} · updated {formatTime(r.updated_at)}</div>
            </li>
          ))}
        </ul>
      )}
      {can(PERM.incidentReports) && (
        choosing ? (
          <div className="rep-choose">
            <p className="muted" style={{ margin: 0 }}>Choose a form. FallGuard fills in what it knows (time, place, cameras, response, video evidence); you complete the rest.</p>
            {createError && <p className="notice notice--error">{createError}</p>}
            {FORMS.map((f) => (
              <button key={f.id} className="rep-choose__item" disabled={!!busy} onClick={() => void create(f.id)}>
                <strong>{busy === f.id ? 'Creating…' : f.short}</strong>
                <span className="muted">{f.authority}</span>
                <span className="rep-choose__desc">{f.description}</span>
              </button>
            ))}
            <button className="btn btn--sm" onClick={() => setChoosing(false)}>Cancel</button>
          </div>
        ) : (
          <button className="btn" onClick={() => setChoosing(true)}><Icon name="file" size={16} /> Create incident report</button>
        )
      )}
    </>
  );
}
