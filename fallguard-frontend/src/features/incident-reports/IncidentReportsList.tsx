import { Link } from 'react-router-dom';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { Icon } from '../../components/ui/Icon';
import { incidentReports, type IncidentReport } from '../../services/api/accounts';
import { usePolling } from '../../services/api/usePolling';
import { formatTime } from '../../lib/format';
import { formById } from './forms';

const csvCell = (s: string) => {
  const v = /^[=+\-@\t\r]/.test(s) ? "'" + s : s; // keep spreadsheets from running text as a formula
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};

/** OSHA 300 Log rows from the OSHA 301 reports, as a CSV download. */
function downloadOsha300(reports: IncidentReport[]) {
  const head = ['Case no.', 'Employee name', 'Job title', 'Date of injury', 'Where the event occurred',
    'Describe injury, parts of body affected, and object/substance', 'Classification', 'Days away', 'Days restricted', 'Injury type', 'Privacy case'];
  const rows = reports.filter((r) => r.form === 'osha_301').map((r) => {
    const f = r.content.fields ?? {};
    const privacy = f.privacy_case === 'Yes';
    return [f.case_number ?? '', privacy ? 'Privacy case' : f.employee_name ?? '', f.employee_job ?? '', f.injury_date ?? '', f.where ?? '',
      [f.injury, f.object].filter(Boolean).join('; '), f.classification ?? '', f.days_away ?? '', f.days_restricted ?? '', f.injury_type ?? '', privacy ? 'Yes' : 'No'];
  });
  const csv = '﻿' + [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `osha-300-log-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Every incident report of the organization (Reports & Export page). */
export function IncidentReportsList() {
  const { data, error } = usePolling(() => incidentReports.list(), 30000);
  const reports = data?.reports ?? [];
  const osha = reports.filter((r) => r.form === 'osha_301').length;

  return (
    <section className="card rp-section">
      <div className="rp-head">
        <h2 className="section-title">Incident reports</h2>
        {osha > 0 && (
          <button className="btn" onClick={() => downloadOsha300(reports)}>
            <Icon name="download" size={16} /> OSHA 300 Log (CSV)
          </button>
        )}
      </div>
      <p className="muted rp-note">WSIB Form 7, OHSA notices, OSHA 301 and internal reports. Start one from a fall event's page; FallGuard fills in what it recorded.</p>
      {error && <p className="notice notice--error">{error}</p>}
      {reports.length === 0 ? <p className="muted">No incident reports yet.</p> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Report</th><th>Incident</th><th>Status</th><th>Started by</th><th>Updated</th></tr></thead>
            <tbody>
              {reports.map((r) => (
                <tr key={r.id}>
                  <td><Link to={`/incident-reports/${r.id}`}><strong>{formById(r.form)?.short ?? r.form}</strong></Link>
                    <div className="muted" style={{ fontSize: 12 }}>{r.title}</div></td>
                  <td><Link to={`/events/${r.incident_id}`}>{r.camera_name ?? 'Incident'}</Link>
                    <div className="muted" style={{ fontSize: 12 }}>{formatTime(r.incident_started_at)}</div></td>
                  <td><StatusBadge value={r.status === 'final' ? 'resolved' : 'acknowledged'} label={r.status === 'final' ? 'Final' : 'Draft'} /></td>
                  <td className="muted">{r.created_by ?? '—'}</td>
                  <td className="muted">{formatTime(r.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
