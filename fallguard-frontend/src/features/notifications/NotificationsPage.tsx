import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { MessagePreview } from '../../components/ui/MessagePreview';
import { PageHeader } from '../../components/ui/PageHeader';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { Icon } from '../../components/ui/Icon';
import { UnsavedChangesGuard } from '../../components/ui/UnsavedChangesGuard';
import {
  notifications, type Delivery, type EmailProvider, type NotificationSettings, type NotifyChannel, type NotifyConfig,
  type NotifyEvent, type NotifySeverity, type Recipient, type SMSProvider,
} from '../../services/api/accounts';
import { usePolling } from '../../services/api/usePolling';
import { formatTime } from '../../lib/format';
import { useAuth } from '../auth/AuthContext';
import './notifications.css';

const SEVERITIES: NotifySeverity[] = ['medium', 'high', 'critical'];
const SEV_LABEL: Record<NotifySeverity, string> = { medium: 'Medium', high: 'High', critical: 'Critical' };
const CHANNELS: { key: NotifyChannel; label: string; hint: string }[] = [
  { key: 'app', label: 'In-app', hint: 'Bell, alarm sound and desktop notification for everyone signed in' },
  { key: 'email', label: 'Email', hint: 'To the email recipients below' },
  { key: 'sms', label: 'SMS', hint: 'To the SMS recipients below' },
];
const EVENTS: { key: NotifyEvent; label: string }[] = [
  { key: 'alert', label: 'Fall alert (new or escalated)' },
  { key: 'recovered', label: 'Follow-up: person recovered' },
  { key: 'false_alarm', label: 'Follow-up: false alarm' },
  { key: 'resolved', label: 'Follow-up: resolved' },
];
const FOLLOW_UPS: { key: keyof NotifyConfig['follow_ups']; label: string; hint: string }[] = [
  { key: 'recovered', label: 'The person recovered', hint: 'The detector saw them get back up.' },
  { key: 'false_alarm', label: 'An operator marked it a false alarm', hint: 'Includes who marked it.' },
  { key: 'resolved', label: 'An operator resolved the alert', hint: 'Includes who resolved it.' },
];

function errorText(e: unknown) {
  return e instanceof Error ? e.message.charAt(0).toUpperCase() + e.message.slice(1) : String(e);
}

type Msg = { ok: boolean; text: string } | null;
const Notice = ({ m }: { m: Msg }) => (m ? <p className={`notice${m.ok ? '' : ' notice--error'}`} role="status">{m.text}</p> : null);

/** Severity × channel checkboxes. */
function Matrix({ cfg, set }: { cfg: NotifyConfig; set: (c: NotifyConfig) => void }) {
  return (
    <div className="table-wrap">
      <table className="table notif-matrix">
        <caption className="visually-hidden">Which channels are used at each severity</caption>
        <thead>
          <tr>
            <th scope="col">Channel</th>
            {SEVERITIES.map((s) => <th key={s} scope="col" className="notif-matrix__sev"><StatusBadge value={s} label={SEV_LABEL[s]} /></th>)}
          </tr>
        </thead>
        <tbody>
          {CHANNELS.map((ch) => (
            <tr key={ch.key}>
              <th scope="row" className="notif-matrix__ch"><span>{ch.label}</span><small className="muted">{ch.hint}</small></th>
              {SEVERITIES.map((s) => (
                <td key={s} className="notif-matrix__cell">
                  <input type="checkbox" checked={cfg.matrix[ch.key][s]} aria-label={`${ch.label} at ${SEV_LABEL[s]} severity`}
                    onChange={(e) => set({ ...cfg, matrix: { ...cfg.matrix, [ch.key]: { ...cfg.matrix[ch.key], [s]: e.target.checked } } })} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Email or SMS recipients, each with the severities they get. */
function Recipients({ kind, list, set, members, matrix }: {
  kind: 'email' | 'sms'; list: Recipient[]; set: (l: Recipient[]) => void;
  members: NotificationSettings['members']; matrix: Record<NotifySeverity, boolean>;
}) {
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const isEmail = kind === 'email';
  const update = (i: number, r: Partial<Recipient>) => set(list.map((x, j) => (j === i ? { ...x, ...r } : x)));
  const add = (r: Recipient) => {
    if (list.some((x) => x.address.toLowerCase() === r.address.toLowerCase())) return;
    set([...list, r]);
  };
  const defaultSev = SEVERITIES.filter((s) => matrix[s]);
  const pickable = members.filter((m) => (isEmail ? m.email : m.phone) && !list.some((x) => x.user_id === m.user_id));
  const uncovered = SEVERITIES.filter((s) => matrix[s] && !list.some((r) => r.enabled && r.severities.includes(s)));

  return (
    <>
      {uncovered.length > 0 && (
        <p className="notice">{isEmail ? 'Email' : 'SMS'} is on for {uncovered.map((s) => SEV_LABEL[s]).join(', ')} but nobody below receives it yet.</p>
      )}
      {list.length === 0 ? <p className="muted">No {isEmail ? 'email' : 'SMS'} recipients yet.</p> : (
        <div className="table-wrap">
          <table className="table notif-recipients">
            <thead>
              <tr>
                <th>Recipient</th>
                {SEVERITIES.map((s) => <th key={s} className="notif-matrix__sev">{SEV_LABEL[s]}</th>)}
                <th>On</th><th />
              </tr>
            </thead>
            <tbody>
              {list.map((r, i) => (
                <tr key={r.address}>
                  <td><strong className="notif-recipients__line">{r.name || r.address}</strong>{r.name && <div className="muted mono notif-recipients__line" title={r.address}>{r.address}</div>}
                    {r.user_id && <div className="muted" style={{ fontSize: 12 }}>Member</div>}</td>
                  {SEVERITIES.map((s) => (
                    <td key={s} className="notif-matrix__cell">
                      {/* Off for this severity: a tip (1 s, or tap) says where to switch it on. */}
                      <span className="tip" tabIndex={matrix[s] ? undefined : 0}
                        data-tip={matrix[s] ? undefined : `${isEmail ? 'Email' : 'SMS'} is off for ${SEV_LABEL[s]}: turn it on in "When to notify" above`}>
                        <input type="checkbox" checked={r.severities.includes(s)} disabled={!matrix[s]}
                          aria-label={`${r.name || r.address}: ${SEV_LABEL[s]}${matrix[s] ? '' : ` (off: turn on ${isEmail ? 'email' : 'SMS'} for ${SEV_LABEL[s]} in When to notify)`}`}
                          onChange={(e) => update(i, { severities: e.target.checked ? [...r.severities, s] : r.severities.filter((x) => x !== s) })} />
                      </span>
                    </td>
                  ))}
                  <td><label className="switch"><input type="checkbox" checked={r.enabled} onChange={(e) => update(i, { enabled: e.target.checked })}
                    aria-label={`${r.name || r.address} enabled`} /></label></td>
                  <td className="num"><button className="btn btn--sm btn--danger" onClick={() => set(list.filter((_, j) => j !== i))}
                    aria-label={`Remove ${r.name || r.address}`}><Icon name="trash" size={14} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="notif-add">
        {pickable.length > 0 && (
          <label className="field">Add a member
            <select value="" onChange={(e) => {
              const m = members.find((x) => x.user_id === e.target.value);
              if (m) add({ name: m.name, address: (isEmail ? m.email : m.phone) ?? '', user_id: m.user_id, severities: defaultSev, enabled: true });
            }}>
              <option value="">Choose…</option>
              {pickable.map((m) => <option key={m.user_id} value={m.user_id}>{m.name} ({isEmail ? m.email : m.phone})</option>)}
            </select>
          </label>
        )}
        <form className="notif-add__manual" onSubmit={(e) => {
          e.preventDefault();
          add({ name: name.trim(), address: address.trim(), user_id: null, severities: defaultSev, enabled: true });
          setName(''); setAddress('');
        }}>
          <label className="field">Name (optional)<input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder={isEmail ? 'Night nurse desk' : 'On-call supervisor'} /></label>
          <label className="field">{isEmail ? 'Email address' : 'Mobile number'}
            <input value={address} onChange={(e) => setAddress(e.target.value)} required type={isEmail ? 'email' : 'tel'}
              placeholder={isEmail ? 'desk@company.com' : '+14165550123'} pattern={isEmail ? undefined : '\\+?[0-9 ()\\-.]{8,20}'} />
          </label>
          <button className="btn"><Icon name="plus" size={16} /> Add</button>
        </form>
      </div>
      {!isEmail && <p className="muted" style={{ fontSize: 13 }}>Use international format (+1 for Canada and the US). Members can add their number under My account.</p>}
    </>
  );
}

/** Custom or default message for each event, with placeholders and a preview. */
function Templates({ cfg, set, defaults, placeholders }: {
  cfg: NotifyConfig; set: (c: NotifyConfig) => void;
  defaults: NotificationSettings['default_templates']; placeholders: Record<string, string>;
}) {
  const [event, setEvent] = useState<NotifyEvent>('alert');
  const [preview, setPreview] = useState<{ subject: string; body: string; sms: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const t = cfg.templates[event] ?? { ...defaults[event], custom: false };
  const shown = t.custom ? t : defaults[event];
  const update = (patch: Partial<typeof t>) => {
    setPreview(null);
    set({ ...cfg, templates: { ...cfg.templates, [event]: { ...t, ...patch } } });
  };

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row">
        <label className="field" style={{ minWidth: 260 }}>Message
          <select value={event} onChange={(e) => { setEvent(e.target.value as NotifyEvent); setPreview(null); }}>
            {EVENTS.map((ev) => <option key={ev.key} value={ev.key}>{ev.label}</option>)}
          </select>
        </label>
        <div role="radiogroup" aria-label="Template" className="row" style={{ alignSelf: 'flex-end' }}>
          <button type="button" role="radio" aria-checked={!t.custom} className={`btn${!t.custom ? ' btn--primary' : ''}`}
            onClick={() => update({ custom: false })}>Use default</button>
          <button type="button" role="radio" aria-checked={t.custom} className={`btn${t.custom ? ' btn--primary' : ''}`}
            onClick={() => update({ custom: true, subject: t.subject || defaults[event].subject, body: t.body || defaults[event].body, sms: t.sms || defaults[event].sms })}>
            Custom</button>
        </div>
      </div>
      <fieldset className="notif-template" disabled={!t.custom}>
        <label className="field">Email subject
          <input value={shown.subject} onChange={(e) => update({ subject: e.target.value })} maxLength={300} />
        </label>
        <label className="field">Email body
          <textarea value={shown.body} onChange={(e) => update({ body: e.target.value })} rows={10} maxLength={10000} className="mono" />
        </label>
        <label className="field">SMS text
          <textarea value={shown.sms} onChange={(e) => update({ sms: e.target.value })} rows={2} maxLength={480} />
          <small>{shown.sms.length} / 480 characters before filling in. Long texts are sent as several SMS.</small>
        </label>
      </fieldset>
      {!t.custom && <p className="muted" style={{ margin: 0 }}>The default text is used. Choose Custom to edit it.</p>}
      <details className="notif-placeholders">
        <summary>Placeholders you can use</summary>
        <ul>{Object.entries(placeholders).sort().map(([k, v]) => <li key={k}><code>{`{{${k}}}`}</code> <span className="muted">{v}</span></li>)}</ul>
      </details>
      <div className="row">
        <button type="button" className="btn" onClick={async () => {
          setError(null);
          try { setPreview(await notifications.preview(event, shown)); } catch (e) { setError(errorText(e)); }
        }}>Preview with sample data</button>
      </div>
      {error && <p className="notice notice--error">{error}</p>}
      {preview && (
        <div className="notif-preview card">
          <p><strong>Subject:</strong> {preview.subject}</p>
          <pre>{preview.body}</pre>
          <p><strong>SMS:</strong> {preview.sms}</p>
        </div>
      )}
    </div>
  );
}

/** On / off line at the top of a provider card, for what is saved (not the unsaved choice). */
function ProviderStatus({ on, text }: { on: boolean; text: string }) {
  return (
    <p className="notif-status" role="status">
      <span className={`badge badge--${on ? 'good' : 'warning'}`}>{on ? 'Sending' : 'Off'}</span>
      <span className="muted">{text}</span>
    </p>
  );
}

function emailStatus(p: EmailProvider, serverFrom: string): { on: boolean; text: string } {
  if (p.type === 'server') return { on: true, text: `Emails are sent from ${serverFrom || "FallGuard's address"}.` };
  if (p.type === 'smtp') return { on: true, text: `Emails are sent from ${p.from_email} through ${p.host}.` };
  return { on: false, text: "Fall alerts aren't emailed. Choose how to send them below." };
}

function EmailProviderCard({ initial, defaultTo, systemSmtp, serverFrom }: {
  initial: EmailProvider; defaultTo: string; systemSmtp: boolean; serverFrom: string;
}) {
  const [p, setP] = useState<EmailProvider>({ ...initial, port: initial.port || 587, security: initial.security || 'starttls', password: '' });
  const [saved, setSaved] = useState<EmailProvider>(initial);
  const [to, setTo] = useState(defaultTo);
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<EmailProvider>) => { setP({ ...p, ...patch }); setMsg(null); };
  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    try { setMsg({ ok: true, text: await fn() }); } catch (e) { setMsg({ ok: false, text: errorText(e) }); } finally { setBusy(false); }
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await notifications.saveEmail(p);
      setP({ ...p, ...r.email_provider, password: '' });
      setSaved(r.email_provider);
      return 'Saved.';
    });
  };

  return (
    <section className="card notif-section">
      <h2 className="section-title">Email</h2>
      <ProviderStatus {...emailStatus(saved, serverFrom)} />
      <form onSubmit={save} className="stack" style={{ gap: 12 }}>
        <div role="radiogroup" aria-label="How to send emails" className="notif-choices">
          {systemSmtp && (
            <label className="notif-choice">
              <input type="radio" checked={p.type === 'server'} onChange={() => set({ type: 'server' })} />
              <span><b>FallGuard's email</b> <span className="muted">(recommended)</span>
                <small>Sent from {serverFrom || "FallGuard's address"}. Nothing to set up.</small></span>
            </label>
          )}
          <label className="notif-choice">
            <input type="radio" checked={p.type === 'smtp'} onChange={() => set({ type: 'smtp' })} />
            <span><b>Your own email server</b>
              <small>Send from your organization's address (e.g. Microsoft 365 or Gmail, SMTP).</small></span>
          </label>
          <label className="notif-choice">
            <input type="radio" checked={p.type === 'log'} onChange={() => set({ type: 'log' })} />
            <span><b>Off</b>
              <small>No alert emails. They're only noted in the server's log (for testing).</small></span>
          </label>
        </div>
        {p.type === 'smtp' && (
          <div className="form-grid">
            <label className="field">SMTP host<input value={p.host} onChange={(e) => set({ host: e.target.value })} required placeholder="smtp.office365.com" /></label>
            <label className="field">Port<input type="number" min={1} max={65535} value={p.port} onChange={(e) => set({ port: Number(e.target.value) })} /></label>
            <label className="field">Security
              <select value={p.security} onChange={(e) => set({ security: e.target.value as EmailProvider['security'], port: e.target.value === 'tls' ? 465 : e.target.value === 'none' ? 25 : 587 })}>
                <option value="starttls">STARTTLS (port 587)</option>
                <option value="tls">TLS (port 465)</option>
                <option value="none">None (local relay only)</option>
              </select>
            </label>
            <label className="field">Username<input value={p.username} onChange={(e) => set({ username: e.target.value })} autoComplete="off" /></label>
            <label className="field">Password
              <input type="password" value={p.password ?? ''} onChange={(e) => set({ password: e.target.value })} autoComplete="new-password"
                placeholder={p.password_set ? 'Saved (leave empty to keep)' : ''} />
              <small>Stored encrypted. App passwords work for Gmail / Microsoft 365.</small>
            </label>
            <label className="field">From address<input type="email" value={p.from_email} onChange={(e) => set({ from_email: e.target.value })} required placeholder="alerts@company.com" /></label>
            <label className="field">From name<input value={p.from_name} onChange={(e) => set({ from_name: e.target.value })} placeholder="FallGuard" /></label>
          </div>
        )}
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          {systemSmtp ? `This is for fall alerts. Invitations and password resets always come from ${serverFrom || "FallGuard's address"}.`
            : 'This is for fall alerts. Invitations and password resets use it too.'}
        </p>
        <Notice m={msg} />
        <div className="row notif-test">
          <button className="btn btn--primary" disabled={busy}>Save</button>
          <span className="notif-test__sep" />
          <input type="email" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Send test email to" placeholder="you@company.com" />
          <button type="button" className="btn" disabled={busy || !to}
            onClick={() => void run(async () => (await notifications.testEmail(to, p)).message)}>
            <Icon name="mail" size={16} /> Send test email</button>
        </div>
      </form>
    </section>
  );
}

function SMSProviderCard({ initial, defaultTo }: { initial: SMSProvider; defaultTo: string }) {
  const [p, setP] = useState<SMSProvider>({ ...initial, auth_token: '' });
  const [saved, setSaved] = useState<SMSProvider>(initial);
  const [to, setTo] = useState(defaultTo);
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<SMSProvider>) => { setP({ ...p, ...patch }); setMsg(null); };
  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    try { setMsg({ ok: true, text: await fn() }); } catch (e) { setMsg({ ok: false, text: errorText(e) }); } finally { setBusy(false); }
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await notifications.saveSMS(p);
      setP({ ...p, ...r.sms_provider, auth_token: '' });
      setSaved(r.sms_provider);
      return 'Saved.';
    });
  };

  return (
    <section className="card notif-section">
      <h2 className="section-title">Text messages (SMS)</h2>
      <ProviderStatus on={saved.type === 'twilio'}
        text={saved.type === 'twilio' ? `Texts are sent from ${saved.from_number} with Twilio.` : "Fall alerts aren't texted. Connect a Twilio account below."} />
      <form onSubmit={save} className="stack" style={{ gap: 12 }}>
        <div role="radiogroup" aria-label="How to send text messages" className="notif-choices">
          <label className="notif-choice">
            <input type="radio" checked={p.type === 'twilio'} onChange={() => set({ type: 'twilio' })} />
            <span><b>Twilio account</b>
              <small>Paste your Twilio details. Texts cost a few cents each, billed by Twilio.</small></span>
          </label>
          <label className="notif-choice">
            <input type="radio" checked={p.type === 'log'} onChange={() => set({ type: 'log' })} />
            <span><b>Off</b>
              <small>No alert texts. They're only noted in the server's log (for testing).</small></span>
          </label>
        </div>
        {p.type === 'twilio' && (
          <div className="form-grid">
            <label className="field">Account SID<input value={p.account_sid} onChange={(e) => set({ account_sid: e.target.value })} required placeholder="AC…" className="mono" /></label>
            <label className="field">Auth token
              <input type="password" value={p.auth_token ?? ''} onChange={(e) => set({ auth_token: e.target.value })} autoComplete="new-password"
                placeholder={p.auth_token_set ? 'Saved (leave empty to keep)' : ''} />
              <small>Stored encrypted.</small>
            </label>
            <label className="field">From number<input value={p.from_number} onChange={(e) => set({ from_number: e.target.value })} required placeholder="+15005550006" />
              <small>Your Twilio number, or a Messaging Service SID (MG…)</small></label>
          </div>
        )}
        <Notice m={msg} />
        <div className="row notif-test">
          <button className="btn btn--primary" disabled={busy}>Save</button>
          <span className="notif-test__sep" />
          <input type="tel" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Send test SMS to" placeholder="+14165550123" />
          <button type="button" className="btn" disabled={busy || !to}
            onClick={() => void run(async () => (await notifications.testSMS(to, p)).message)}>Send test SMS</button>
        </div>
      </form>
    </section>
  );
}

const DELIVERY_TONE: Record<Delivery['status'], string> = { sent: 'resolved', logged: 'paused', pending: 'acknowledged', failed: 'open' };

function DeliveryHistory() {
  const { data, error } = usePolling(() => notifications.deliveries(), 15000);
  const list = data?.deliveries ?? [];
  const [open, setOpen] = useState<Delivery | null>(null);
  const load = useCallback(async () => {
    const r = await notifications.deliveryPreview(open!.id);
    return r.html ? { html: r.html } : { text: r.body };
  }, [open]);
  const about = (d: Delivery) => (d.event.startsWith('alert:') ? `Alert (${d.event.slice(6)})` : d.event.replace('_', ' '));
  return (
    <section className="card notif-section">
      <h2 className="section-title">Recent messages</h2>
      {error && <p className="notice notice--error">{error}</p>}
      {list.length === 0 ? <p className="muted">No email or SMS sent yet.</p> : (
        <div className="table-wrap">
          <table className="table table--stack">
            <thead><tr><th>When</th><th>About</th><th>Channel</th><th>To</th><th>Status</th></tr></thead>
            <tbody>
              {list.map((d) => (
                <tr key={d.id} className="is-link" tabIndex={0} onClick={() => setOpen(d)}
                  onKeyDown={(k) => (k.key === 'Enter' || k.key === ' ') && (k.preventDefault(), setOpen(d))}
                  aria-label={`Preview the ${d.channel === 'email' ? 'email' : 'text message'} to ${d.recipient}`}>
                  <td className="muted">{formatTime(d.created_at)}</td>
                  <td>{about(d)}
                    {d.subject && <div className="muted" style={{ fontSize: 12 }}>{d.subject}</div>}</td>
                  <td>{d.channel === 'email' ? 'Email' : 'SMS'}</td>
                  <td className="mono">{d.recipient}</td>
                  <td><StatusBadge value={DELIVERY_TONE[d.status]} label={d.status === 'logged' ? 'Not sent (off)' : d.status[0].toUpperCase() + d.status.slice(1)} />
                    {d.error && <div className="muted" style={{ fontSize: 12, maxWidth: 280 }} title={d.error}>{d.error.slice(0, 120)}</div>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && (
        <MessagePreview title={open.subject || (open.channel === 'sms' ? 'Text message' : 'Email')} sms={open.channel === 'sms'}
          load={load} onClose={() => setOpen(null)}
          meta={[
            { label: 'To', value: open.recipient },
            { label: 'About', value: about(open) },
            { label: 'Channel', value: open.channel === 'email' ? 'Email' : 'SMS' },
            { label: 'Sent', value: formatTime(open.sent_at ?? open.created_at) },
            { label: 'Status', value: <StatusBadge value={DELIVERY_TONE[open.status]} label={open.status === 'logged' ? 'Not sent (off)' : open.status[0].toUpperCase() + open.status.slice(1)} /> },
          ]} />
      )}
    </section>
  );
}

export default function NotificationsPage() {
  const { me } = useAuth();
  const [data, setData] = useState<NotificationSettings | null>(null);
  const [cfg, setCfg] = useState<NotifyConfig | null>(null);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    notifications.settings().then((d) => { setData(d); setCfg(d.config); }).catch((e) => setMsg({ ok: false, text: errorText(e) }));
  }, []);
  const set = (c: NotifyConfig) => { setCfg(c); setDirty(true); setMsg(null); };
  /** Saves; true when saved (the unsaved-changes prompt leaves the page only then). */
  const save = async (): Promise<boolean> => {
    if (!cfg) return false;
    setSaving(true);
    try {
      const r = await notifications.save(cfg);
      setCfg(r.config);
      setDirty(false);
      setMsg({ ok: true, text: 'Notification settings saved.' });
      return true;
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
      return false;
    } finally {
      setSaving(false);
    }
  };

  if (!data || !cfg) {
    return <><PageHeader title="Notifications" />{msg ? <Notice m={msg} /> : <p className="muted">Loading…</p>}</>;
  }

  const saveBar = (
    <div className="notif-savebar">
      <Notice m={msg} />
      <button className="btn btn--primary" disabled={!dirty || saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save changes'}</button>
      {dirty && <span className="muted">Unsaved changes</span>}
    </div>
  );

  return (
    <>
      <UnsavedChangesGuard when={dirty} onSave={save} />
      <PageHeader title="Notifications"
        description="Who is told about falls, how, and at which severity. A fall starts at Medium and rises to High and Critical the longer the person stays down; each level reached sends its own message." />
      <div className="stack">
        <section className="card notif-section">
          <h2 className="section-title">When to notify</h2>
          <Matrix cfg={cfg} set={set} />
        </section>

        <div className="notif-two">
          <section className="card notif-section">
            <h2 className="section-title">Email recipients</h2>
            <Recipients kind="email" list={cfg.email_recipients} members={data.members} matrix={cfg.matrix.email}
              set={(l) => set({ ...cfg, email_recipients: l })} />
          </section>
          <section className="card notif-section">
            <h2 className="section-title">SMS recipients</h2>
            <Recipients kind="sms" list={cfg.sms_recipients} members={data.members} matrix={cfg.matrix.sms}
              set={(l) => set({ ...cfg, sms_recipients: l })} />
          </section>
        </div>

        <section className="card notif-section">
          <h2 className="section-title">Follow-up updates</h2>
          <p className="muted" style={{ marginTop: -6 }}>Sent to the people who got the alert, by the same channels.</p>
          <div className="stack" style={{ gap: 10 }}>
            {FOLLOW_UPS.map((f) => (
              <label key={f.key} className="switch">
                <input type="checkbox" checked={cfg.follow_ups[f.key]}
                  onChange={(e) => set({ ...cfg, follow_ups: { ...cfg.follow_ups, [f.key]: e.target.checked } })} />
                <span>{f.label} <span className="muted">· {f.hint}</span></span>
              </label>
            ))}
          </div>
        </section>

        <section className="card notif-section">
          <h2 className="section-title">Message templates</h2>
          <Templates cfg={cfg} set={set} defaults={data.default_templates} placeholders={data.placeholders} />
          <label className="field" style={{ marginTop: 16, maxWidth: 420 }}>App address for links in messages
            <input value={cfg.app_url} onChange={(e) => set({ ...cfg, app_url: e.target.value })} placeholder={window.location.origin} />
            <small>Leave empty to use the server's setting. Recipients open incidents with this address.</small>
          </label>
        </section>

        {saveBar}

        <div className="notif-two">
          <EmailProviderCard initial={data.email_provider} defaultTo={me?.user.email ?? ''} systemSmtp={data.system_smtp} serverFrom={data.server_from ?? ''} />
          <SMSProviderCard initial={data.sms_provider} defaultTo={me?.user.phone ?? ''} />
        </div>

        <DeliveryHistory />
      </div>
    </>
  );
}
