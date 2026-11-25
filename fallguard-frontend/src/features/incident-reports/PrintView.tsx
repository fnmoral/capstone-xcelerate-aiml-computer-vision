import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { incidentReports, type IncidentReport, type ReportFacts } from '../../services/api/accounts';
import { snapshotUrl } from '../../services/api/fallguard';
import { formatTime } from '../../lib/format';
import { formById } from './forms';
import './reports.css';

/** The report as a printable document (shown only when printing / saving as PDF). */
export function PrintView({ report, fields, facts }: { report: IncidentReport; fields: Record<string, string>; facts: ReportFacts | null }) {
  const form = formById(report.form);
  if (!form) return null;
  const snap = facts?.cameras.find((c) => c.snapshot_key)?.snapshot_key;
  return (
    <article className="rep-print" aria-hidden="true">
      <header className="rep-print__head">
        <div>
          <img src="/brand/logo-horizontal-vision-light.svg" alt="FallGuard Vision" className="rep-print__logo" />
          <h1>{form.name}</h1>
          <p>{facts?.org.legal_name || facts?.org.name}</p>
          <p className="rep-print__for">Prepared for: {form.authority}</p>
        </div>
        <div className="rep-print__meta">
          <div>Status: {report.status === 'final' ? 'Final' : 'Draft'}</div>
          <div>Incident {report.incident_id.slice(0, 8)}</div>
          {report.incident_started_at && <div>Fall on {formatTime(report.incident_started_at)}</div>}
          <div>Printed {new Date().toLocaleString()}</div>
        </div>
      </header>
      <p className="rep-print__deadline"><strong>Deadline:</strong> {form.deadline}</p>
      {form.sections.map((s) => (
        <section key={s.title} className="rep-print__section">
          <h2>{s.title}</h2>
          <dl>
            {s.fields.map((f) => (
              <div key={f.key} className={f.wide || f.type === 'textarea' ? 'wide' : ''}>
                <dt>{f.label}</dt>
                <dd>{fields[f.key]?.trim() || '—'}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
      {snap && (
        <section className="rep-print__section">
          <h2>Snapshot</h2>
          <img src={snapshotUrl(snap)} alt="" className="rep-print__snap" />
        </section>
      )}
      <footer className="rep-print__foot">
        <p>{form.disclaimer}</p>
        <p>Signature: ______________________________ Date: ______________</p>
      </footer>
    </article>
  );
}

/** Waits until the images inside el have loaded (or failed), at most ms. */
function imagesLoaded(el: HTMLElement, ms: number) {
  const pending = [...el.querySelectorAll('img')].filter((i) => !i.complete)
    .map((i) => new Promise<void>((done) => { i.onload = i.onerror = () => done(); }));
  return Promise.race([Promise.all(pending), new Promise((done) => setTimeout(done, ms))]);
}

/**
 * Prints several reports in one go, each starting on a new page (the browser's print dialog
 * also saves as PDF). print(list) loads each incident's facts (organization name, snapshot)
 * when allowed, then opens the dialog with only these reports on it.
 */
export function useReportPrinter(withFacts: boolean) {
  const [batch, setBatch] = useState<{ reports: IncidentReport[]; facts: Record<string, ReportFacts | null> } | null>(null);
  const [loading, setLoading] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!batch || !box.current) return;
    let cancelled = false;
    document.body.classList.add('printing-batch');
    const done = () => { document.body.classList.remove('printing-batch'); setBatch(null); };
    window.addEventListener('afterprint', done, { once: true });
    void imagesLoaded(box.current, 5000).then(() => { if (!cancelled) window.print(); });
    return () => { cancelled = true; window.removeEventListener('afterprint', done); document.body.classList.remove('printing-batch'); };
  }, [batch]);

  const print = async (reports: IncidentReport[]) => {
    if (reports.length === 0) return;
    setLoading(true);
    const facts: Record<string, ReportFacts | null> = {};
    if (withFacts) {
      const ids = [...new Set(reports.map((r) => r.incident_id))];
      await Promise.all(ids.map((id) => incidentReports.facts(id).then((f) => { facts[id] = f; }, () => { facts[id] = null; })));
    }
    setLoading(false);
    setBatch({ reports, facts });
  };

  // In <body> itself, so printing can hide everything else (body.printing-batch in reports.css).
  const sheets = batch && createPortal(
    <div ref={box} className="rep-print-batch">
      {batch.reports.map((r) => (
        <PrintView key={r.id} report={r} fields={r.content.fields ?? {}} facts={batch.facts[r.incident_id] ?? null} />
      ))}
    </div>,
    document.body,
  );
  return { print, loading, sheets };
}
