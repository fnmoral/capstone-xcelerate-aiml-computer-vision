import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { PageHeader } from '../../components/ui/PageHeader';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { Icon } from '../../components/ui/Icon';
import { incidentReports, type IncidentReport, type ReportFacts } from '../../services/api/accounts';
import { snapshotUrl } from '../../services/api/fallguard';
import { formatTime } from '../../lib/format';
import { PERM, useAuth } from '../auth/AuthContext';
import { autoFill, formById, missing, type Field } from './forms';
import './reports.css';

const errorText = (e: unknown) => (e instanceof Error ? e.message.charAt(0).toUpperCase() + e.message.slice(1) : String(e));

function FieldInput({ f, value, onChange, disabled, auto }: {
  f: Field; value: string; onChange: (v: string) => void; disabled: boolean; auto: boolean;
}) {
  const id = `fld-${f.key}`;
  const empty = f.required && !value.trim();
  const label = (
    <span className="rep-label">
      {f.label}{f.required && <span aria-hidden="true" className="rep-req"> *</span>}
      {auto && <span className="rep-chip" title="Filled in from FallGuard records. Check it.">Auto-filled</span>}
      {empty && <span className="rep-chip rep-chip--need">Needs input</span>}
    </span>
  );
  const common = { id, value, disabled, required: f.required, onChange: (e: { target: { value: string } }) => onChange(e.target.value) };
  let input;
  switch (f.type) {
    case 'textarea':
      input = <textarea {...common} rows={Math.min(14, Math.max(3, value.split('\n').length + 1))} />;
      break;
    case 'select':
      input = (
        <select {...common}>
          <option value="">Choose…</option>
          {f.options?.map((o) => <option key={o} value={o}>{o}</option>)}
          {value && !f.options?.includes(value) && <option value={value}>{value}</option>}
        </select>
      );
      break;
    default:
      input = <input {...common} type={f.type ?? 'text'} min={f.type === 'number' ? 0 : undefined} />;
  }
  return (
    <label className={`field rep-field${f.wide || f.type === 'textarea' ? ' rep-field--wide' : ''}${empty ? ' rep-field--empty' : ''}`} htmlFor={id}>
      {label}
      {input}
      {f.help && <small>{f.help}</small>}
    </label>
  );
}

/** The report as a printable document (shown when printing / saving as PDF). */
function PrintView({ report, fields, facts }: { report: IncidentReport; fields: Record<string, string>; facts: ReportFacts | null }) {
  const form = formById(report.form)!;
  const snap = facts?.cameras.find((c) => c.snapshot_key)?.snapshot_key;
  return (
    <article className="rep-print" aria-hidden="true">
      <header className="rep-print__head">
        <div>
          <h1>{form.name}</h1>
          <p>{facts?.org.legal_name || facts?.org.name} · {form.authority}</p>
        </div>
        <div className="rep-print__meta">
          <div>Status: {report.status === 'final' ? 'Final' : 'Draft'}</div>
          <div>Incident {report.incident_id.slice(0, 8)}</div>
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

export default function ReportEditorPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [report, setReport] = useState<IncidentReport | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [auto, setAuto] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [facts, setFacts] = useState<ReportFacts | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const canEdit = can(PERM.incidentReports);
  useEffect(() => {
    incidentReports.get(id).then(({ report: r }) => {
      setReport(r);
      setFields(r.content.fields ?? {});
      setAuto(r.content.auto ?? []);
      setTitle(r.title);
      if (can(PERM.incidentReports)) incidentReports.facts(r.incident_id).then(setFacts).catch(() => undefined);
    }).catch((e) => setMsg({ ok: false, text: errorText(e) }));
  }, [id, can]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const form = report ? formById(report.form) : undefined;
  const need = useMemo(() => (form ? missing(form, fields) : []), [form, fields]);
  if (!report || !form) return msg ? <p className="notice notice--error">{msg.text}</p> : <p className="muted">Loading…</p>;
  const locked = !canEdit || report.status === 'final';

  const change = (key: string, v: string) => {
    setFields({ ...fields, [key]: v });
    setAuto(auto.filter((k) => k !== key)); // edited by a person: no longer "auto-filled"
    setDirty(true);
    setMsg(null);
  };

  const save = async (status: 'draft' | 'final') => {
    if (status === 'final' && need.length > 0 &&
      !confirm(`${need.length} required field${need.length > 1 ? 's are' : ' is'} still empty. Mark as final anyway?`)) return;
    setBusy(true);
    try {
      const { report: r } = await incidentReports.save(report.id, { title, status, content: { fields, auto, facts_at: report.content.facts_at } });
      setReport(r);
      setDirty(false);
      setMsg({ ok: true, text: status === 'final' ? 'Marked as final. It can no longer be edited unless reopened.' : 'Saved.' });
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  /** Re-fills the fields still marked auto-filled with the latest records (e.g. after the person recovered). */
  const refresh = async () => {
    setBusy(true);
    try {
      const f = await incidentReports.facts(report.incident_id);
      setFacts(f);
      const filled = autoFill(form, f);
      const next = { ...fields };
      const nextAuto = new Set(auto);
      for (const k of filled.auto) {
        if (auto.includes(k) || !(fields[k] ?? '').trim()) {
          next[k] = filled.fields[k];
          nextAuto.add(k);
        }
      }
      setFields(next);
      setAuto([...nextAuto]);
      setDirty(true);
      setMsg({ ok: true, text: 'Auto-filled fields updated from the latest records. Fields you edited were kept. Save to keep the changes.' });
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="no-print">
        <Link to={`/events/${report.incident_id}`} className="row muted ev-back"><Icon name="back" size={16} /> Back to the incident</Link>
        <PageHeader title={form.short}
          description={`${form.authority} · incident ${report.incident_id.slice(0, 8)} · last saved ${formatTime(report.updated_at)}${report.created_by ? ` · started by ${report.created_by}` : ''}`}
          actions={<>
            <StatusBadge value={report.status === 'final' ? 'resolved' : 'acknowledged'} label={report.status === 'final' ? 'Final' : 'Draft'} />
            <button className="btn" onClick={() => window.print()}><Icon name="download" size={16} /> Print / save as PDF</button>
          </>} />

        <div className="rep-banner card">
          <p><strong>Deadline:</strong> {form.deadline}</p>
          <p className="muted">{form.disclaimer}</p>
          {report.status === 'final' && report.finalized_by && (
            <p className="muted">Finalized by {report.finalized_by} on {formatTime(report.finalized_at)}.</p>
          )}
        </div>
        {msg && <p className={`notice${msg.ok ? '' : ' notice--error'}`} role="status">{msg.text}</p>}
        {!locked && need.length > 0 && (
          <p className="notice">{need.length} required field{need.length > 1 ? 's' : ''} still need{need.length > 1 ? '' : 's'} input: {need.slice(0, 6).map((f) => f.label).join(', ')}{need.length > 6 ? '…' : ''}</p>
        )}

        <div className="stack">
          <label className="field" style={{ maxWidth: 560 }}>Report title
            <input value={title} disabled={locked} maxLength={200} onChange={(e) => { setTitle(e.target.value); setDirty(true); }} />
          </label>
          {form.sections.map((s) => (
            <section key={s.title} className="card rep-section">
              <h2 className="section-title">{s.title}</h2>
              {s.note && <p className="muted rep-note">{s.note}</p>}
              <div className="rep-grid">
                {s.fields.map((f) => (
                  <FieldInput key={f.key} f={f} value={fields[f.key] ?? ''} disabled={locked} auto={auto.includes(f.key)}
                    onChange={(v) => change(f.key, v)} />
                ))}
              </div>
            </section>
          ))}
        </div>

        {canEdit && (
          <div className="rep-actions">
            {report.status === 'draft' ? (
              <>
                <button className="btn btn--primary" disabled={busy || !dirty} onClick={() => void save('draft')}>{busy ? 'Saving…' : 'Save draft'}</button>
                <button className="btn" disabled={busy} onClick={() => void save('final')}><Icon name="check" size={16} /> Mark as final</button>
                <button className="btn" disabled={busy} onClick={() => void refresh()}
                  title="Fill the auto-filled fields again from the latest incident records">Refresh from records</button>
              </>
            ) : (
              <button className="btn" disabled={busy} onClick={() => void save('draft')}>Reopen as draft</button>
            )}
            <span style={{ flex: 1 }} />
            {dirty && <span className="muted">Unsaved changes</span>}
            <button className="btn btn--danger" disabled={busy} onClick={async () => {
              if (!confirm('Delete this report? This cannot be undone.')) return;
              try { await incidentReports.remove(report.id); navigate(`/events/${report.incident_id}`); } catch (e) { setMsg({ ok: false, text: errorText(e) }); }
            }}><Icon name="trash" size={16} /> Delete</button>
          </div>
        )}
      </div>
      <PrintView report={{ ...report, title }} fields={fields} facts={facts} />
    </>
  );
}
