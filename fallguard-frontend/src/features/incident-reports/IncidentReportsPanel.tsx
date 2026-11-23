import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { Icon } from '../../components/ui/Icon';
import { incidentReports, shareLinks, type ReportForm } from '../../services/api/accounts';
import { usePolling } from '../../services/api/usePolling';
import { formatTime } from '../../lib/format';
import { PERM, useAuth } from '../auth/AuthContext';
import { autoFill, carryOver, FORMS, formById, REPORT_SHARE_DAYS, withShareLink } from './forms';
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
      // Reports for an authority get the recipient's view-only video link right away (internal
      // reports are read by staff with an account). Without it, [share link] stays to fill in.
      let link: { id: string; url: string } | null = null;
      if (def.id !== 'internal' && fields.evidence_summary) {
        try {
          const r = await shareLinks.create(incidentId, { recipient: `${def.authority} (${def.short})`, days: REPORT_SHARE_DAYS });
          link = { id: r.link.id, url: r.url };
          fields.evidence_summary = withShareLink(fields.evidence_summary, r.url);
        } catch {
          /* no link: the placeholder stays, and Share video on the incident page can make one */
        }
      }
      let report;
      try {
        ({ report } = await incidentReports.create(incidentId, {
          form, title: `${def.short}: ${facts.incident.camera_name ?? 'fall'} ${fields.accident_date ?? fields.incident_date ?? fields.injury_date ?? fields.occurrence_date ?? ''}`.trim(),
          content: { fields, auto, from, facts_at: facts.generated_at },
        }));
      } catch (e) {
        if (link) await shareLinks.revoke(link.id).catch(() => undefined); // no report: don't leave the link open
        throw e;
      }
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
      {reports.length === 0 ? <p className="muted rep-empty">No reports yet.</p> : (
        <ul className="rep-list">
          {reports.map((r) => (
            <li key={r.id}>
              {/* The whole card opens the report. */}
              <Link to={`/incident-reports/${r.id}`} className="rep-card">
                <span className="rep-card__body">
                  <span className="rep-card__title">
                    <strong>{formById(r.form)?.short ?? r.form}</strong>
                    <StatusBadge value={r.status === 'final' ? 'resolved' : 'acknowledged'} label={r.status === 'final' ? 'Final' : 'Draft'} />
                  </span>
                  <span className="muted rep-card__meta">{r.created_by ?? 'Someone'} · updated {formatTime(r.updated_at)}</span>
                </span>
                <span className="rep-card__open">Open <span className="rep-card__arrow"><Icon name="back" size={14} /></span></span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {can(PERM.incidentReports) && (
        choosing ? (
          <div className="rep-choose">
            <p className="muted rep-choose__intro">Select a form. FallGuard completes the details it recorded (time, location, cameras, response and video evidence); you complete the rest.</p>
            {createError && <p className="notice notice--error">{createError}</p>}
            {FORMS.map((f) => (
              <button key={f.id} className="rep-choose__item" disabled={!!busy} onClick={() => void create(f.id)}>
                <strong>{busy === f.id ? 'Creating…' : f.short}</strong>
                <span className="muted rep-choose__authority">{f.authority}</span>
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
