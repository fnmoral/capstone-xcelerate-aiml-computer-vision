import { useState } from 'react';
import { Link } from 'react-router-dom';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { Icon } from '../../components/ui/Icon';
import { incidentReports, type IncidentReport } from '../../services/api/accounts';
import { usePolling } from '../../services/api/usePolling';
import { formatTime } from '../../lib/format';
import { PERM, useAuth } from '../auth/AuthContext';
import { formById } from './forms';
import { useReportPrinter } from './PrintView';

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

/** Deleted reports that can still be restored, with the date each is removed for good. */
function RecentlyDeleted({ onRestored }: { onRestored: () => unknown }) {
  const { data, error, reload } = usePolling(() => incidentReports.deleted(), 60000);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const reports = data?.reports ?? [];
  if (reports.length === 0 && !msg && !error) return null;

  const restore = async (r: IncidentReport) => {
    setBusy(r.id);
    try {
      await incidentReports.restore(r.id);
      setMsg({ ok: true, text: `Restored: ${r.title}` });
      await Promise.all([reload(), onRestored()]);
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <h3 className="section-title" style={{ marginTop: 20 }}>Recently deleted</h3>
      <p className="muted rp-note">Deleted reports can be restored until the date shown, then they are removed for good (Settings → Organization sets how long).</p>
      {error && <p className="notice notice--error">{error}</p>}
      {msg && <p className={`notice${msg.ok ? '' : ' notice--error'}`} role="status">{msg.text}</p>}
      {reports.length > 0 && (
        <div className="table-wrap">
          <table className="table table--stack">
            <thead><tr><th>Report</th><th>Incident</th><th>Deleted</th><th>Removed for good</th><th /></tr></thead>
            <tbody>
              {reports.map((r) => (
                <tr key={r.id}>
                  <td><strong>{formById(r.form)?.short ?? r.form}</strong>
                    <div className="muted" style={{ fontSize: 12 }}>{r.title}</div></td>
                  <td><Link to={`/events/${r.incident_id}`}>{r.camera_name ?? 'Incident'}</Link>
                    <div className="muted" style={{ fontSize: 12 }}>{formatTime(r.incident_started_at)}</div></td>
                  <td className="muted">{formatTime(r.deleted_at)}{r.deleted_by ? ` by ${r.deleted_by}` : ''}</td>
                  <td className="muted">{formatTime(r.purge_at)}</td>
                  <td><button className="btn btn--sm" disabled={!!busy} onClick={() => void restore(r)}>{busy === r.id ? 'Restoring…' : 'Restore'}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/**
 * The organization's incident reports (Reports & Export page). With incidentIds, only the
 * reports of those fall events: the page's filters pick events by when the fall happened,
 * not by when the report was written. null = the events are still loading.
 */
export function IncidentReportsList({ incidentIds }: { incidentIds?: Set<string> | null }) {
  const { can } = useAuth();
  const { data, error, reload } = usePolling(() => incidentReports.list(), 30000);
  const printer = useReportPrinter(can(PERM.incidentReports));
  const all = data?.reports ?? [];
  const reports = incidentIds ? all.filter((r) => incidentIds.has(r.incident_id)) : all;
  const osha = reports.filter((r) => r.form === 'osha_301').length;
  const hidden = all.length - reports.length;

  return (
    <section className="card rp-section">
      <div className="rp-head">
        <h2 className="section-title">Incident report forms</h2>
        <div className="row">
          {osha > 0 && (
            <button className="btn" onClick={() => downloadOsha300(reports)}>
              <Icon name="download" size={16} /> OSHA 300 Log (CSV)
            </button>
          )}
          {reports.length > 0 && (
            <button className="btn btn--primary" disabled={printer.loading} onClick={() => void printer.print(reports)}
              title="Opens the print dialog with every report listed below, each on its own pages. Choose Save as PDF to download them.">
              <Icon name="download" size={16} /> {printer.loading ? 'Preparing…' : `Print / PDF all (${reports.length})`}
            </button>
          )}
        </div>
      </div>
      <p className="muted rp-note">
        WSIB Form 7, OHSA notices, OSHA 301 and internal reports. Start one from a fall event's page; FallGuard fills in what it recorded.
        {incidentIds !== undefined && ' Shows the reports of the fall events that match the filters above (by when the fall happened).'}
      </p>
      {error && <p className="notice notice--error">{error}</p>}
      {(!data && !error) || incidentIds === null ? <p className="muted">Loading…</p> : reports.length === 0 ? (
        <p className="muted">{hidden > 0 ? `No reports for these fall events (${hidden} for other events: widen the time window or clear a filter).` : 'No incident reports yet.'}</p>
      ) : (
        <div className="table-wrap">
          <table className="table table--stack">
            <thead><tr><th>Report</th><th>Fall event</th><th>Status</th><th>Started by</th><th>Updated</th><th /></tr></thead>
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
                  <td>
                    <button className="btn btn--sm" disabled={printer.loading} onClick={() => void printer.print([r])}
                      aria-label={`Print or save as PDF: ${formById(r.form)?.short ?? r.form}, ${r.title}`}>
                      Print / PDF
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {hidden > 0 && <p className="muted rp-sub">{hidden} other report(s) belong to fall events outside these filters.</p>}
        </div>
      )}
      {can(PERM.incidentReports) && <RecentlyDeleted onRestored={reload} />}
      {printer.sheets}
    </section>
  );
}
