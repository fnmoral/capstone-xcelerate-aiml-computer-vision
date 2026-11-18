import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { PageHeader } from '../../components/ui/PageHeader';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { Icon } from '../../components/ui/Icon';
import { accounts, type Invitation, type Mailed, type Member, type Role, type RolePermissions } from '../../services/api/accounts';
import { usePolling } from '../../services/api/usePolling';
import { formatTime } from '../../lib/format';
import { PERM, useAuth } from '../auth/AuthContext';
import './members.css';

const ROLES: Role[] = ['admin', 'member', 'viewer'];

export const ROLE_INFO: Record<Role, { label: string; summary: string; detail: string }> = {
  admin: {
    label: 'Admin',
    summary: 'Full control',
    detail: 'Everything a member can do, plus invite and remove people, change roles and decide what members and viewers may do. Every organization keeps at least one admin.',
  },
  member: {
    label: 'Member',
    summary: 'Operate and configure',
    detail: 'Respond to alerts, write incident reports, manage cameras and their layout, detection, notifications and settings. Cannot add or remove people or change roles.',
  },
  viewer: {
    label: 'Viewer',
    summary: 'Read-only',
    detail: 'Watch live cameras and see fall events, reports and logs. Cannot change anything.',
  },
};

function errorText(e: unknown) {
  return e instanceof Error ? e.message.charAt(0).toUpperCase() + e.message.slice(1) : String(e);
}

/** The roles table: one row per permission, a checkbox per role. */
function RolesTable({ editable }: { editable: boolean }) {
  const [data, setData] = useState<RolePermissions | null>(null);
  const [draft, setDraft] = useState<Record<'member' | 'viewer', string[]> | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    accounts.permissions().then((p) => {
      setData(p);
      setDraft({ member: p.roles.member, viewer: p.roles.viewer });
    }).catch((e) => setMessage({ ok: false, text: errorText(e) }));
  }, []);

  const groups = useMemo(() => {
    const out: Record<string, RolePermissions['catalog']> = {};
    for (const p of data?.catalog ?? []) (out[p.group] ??= []).push(p);
    return out;
  }, [data]);

  if (!data || !draft) return message ? <p className="notice notice--error">{message.text}</p> : <p className="muted">Loading roles…</p>;

  const changed = ['member', 'viewer'].some((r) => {
    const a = [...draft[r as 'member']].sort().join(), b = [...data.roles[r as 'member']].sort().join();
    return a !== b;
  });
  const toggle = (role: 'member' | 'viewer', key: string, on: boolean) => {
    setMessage(null);
    setDraft({ ...draft, [role]: on ? [...draft[role], key] : draft[role].filter((k) => k !== key) });
  };
  const save = async () => {
    setSaving(true);
    try {
      const p = await accounts.savePermissions(draft);
      setData(p);
      setDraft({ member: p.roles.member, viewer: p.roles.viewer });
      setMessage({ ok: true, text: 'Saved. People in these roles get the change within a minute.' });
    } catch (e) {
      setMessage({ ok: false, text: errorText(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {message && <p className={`notice${message.ok ? '' : ' notice--error'}`}>{message.text}</p>}
      <div className="table-wrap">
        <table className="table roles-table">
          <caption className="visually-hidden">What each role can do</caption>
          <thead>
            <tr>
              <th scope="col">Permission</th>
              {ROLES.map((r) => <th key={r} scope="col" className="roles-table__role">{ROLE_INFO[r].label}</th>)}
            </tr>
          </thead>
          {Object.entries(groups).map(([group, perms]) => (
            <tbody key={group}>
              <tr className="roles-table__group"><th colSpan={4} scope="rowgroup">{group}</th></tr>
              {perms.map((p) => (
                <tr key={p.key}>
                  <th scope="row" className="roles-table__perm">
                    <span>{p.label}</span>
                    <small className="muted">{p.description}{p.admin_only && ' Admins only.'}</small>
                  </th>
                  <td className="roles-table__cell">
                    <input type="checkbox" checked disabled aria-label={`Admin: ${p.label} (always)`} />
                  </td>
                  {(['member', 'viewer'] as const).map((r) => (
                    <td key={r} className="roles-table__cell">
                      {p.admin_only ? (
                        <span title="Admins only" aria-label={`${ROLE_INFO[r].label}: ${p.label}, not available`} className="roles-table__lock">—</span>
                      ) : (
                        <input type="checkbox" checked={draft[r].includes(p.key)} disabled={!editable}
                          onChange={(e) => toggle(r, p.key, e.target.checked)}
                          aria-label={`${ROLE_INFO[r].label}: ${p.label}`} />
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
      {editable && (
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn btn--primary" disabled={!changed || saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save permissions'}</button>
          <button className="btn" disabled={saving} onClick={() => { setDraft({ ...data.defaults }); setMessage(null); }}>Reset to defaults</button>
          {changed && <span className="muted">Unsaved changes</span>}
        </div>
      )}
    </>
  );
}

function InviteForm({ onSent }: { onSent: () => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string; mailed?: Mailed } | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const r = await accounts.invite(email, role);
      setResult({ ok: true, text: `Invitation sent to ${r.invitation.email}. The link is valid for 7 days.`, mailed: r });
      setEmail('');
      onSent();
    } catch (err) {
      setResult({ ok: false, text: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="invite-form">
      <label className="field">Email
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="name@company.com" />
      </label>
      <label className="field">Role
        <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
          {ROLES.map((r) => <option key={r} value={r}>{ROLE_INFO[r].label}: {ROLE_INFO[r].summary}</option>)}
        </select>
      </label>
      <button className="btn btn--primary" disabled={busy}><Icon name="mail" size={16} /> {busy ? 'Sending…' : 'Send invitation'}</button>
      {result && (
        <p className={`notice${result.ok ? '' : ' notice--error'} invite-form__result`}>
          {result.text}
          {result.mailed?.email_delivery === 'logged' && (result.mailed.dev_link
            ? <> No email server is set up: <a href={result.mailed.dev_link}>invitation link</a> (copy it to them).</>
            : ' No email server is set up yet, so the email was written to the server log. Set one up on the Notifications page.')}
        </p>
      )}
    </form>
  );
}

function MemberRow({ m, self, manage, onChanged }: { m: Member; self: boolean; manage: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const name = `${m.first_name} ${m.last_name}`.trim() || m.email;
  return (
    <tr>
      <td>
        <strong>{name}</strong>{self && <span className="muted"> (you)</span>}
        <div className="muted members-sub">{m.email}</div>
        {error && <div className="members-error" role="alert">{error}</div>}
      </td>
      <td>
        {manage ? (
          <select value={m.role} disabled={busy} aria-label={`Role of ${name}`}
            onChange={(e) => {
              const role = e.target.value as Role;
              if (self && role !== 'admin' && !confirm('Change your own role? You will lose admin access.')) return;
              void run(() => accounts.setRole(m.id, role));
            }}>
            {ROLES.map((r) => <option key={r} value={r}>{ROLE_INFO[r].label}</option>)}
          </select>
        ) : <StatusBadge value={m.role === 'admin' ? 'online' : 'paused'} label={ROLE_INFO[m.role].label} />}
      </td>
      <td className="muted">{m.email_verified ? 'Verified' : 'Not verified'}</td>
      <td className="muted">{m.last_login_at ? formatTime(m.last_login_at) : 'Never'}</td>
      <td className="muted">{formatTime(m.joined_at)}</td>
      <td className="num">
        {manage && !self && (
          <button className="btn btn--sm btn--danger" disabled={busy}
            onClick={() => confirm(`Remove ${name} from the organization? They are signed out right away.`) && void run(() => accounts.removeMember(m.id))}>
            Remove
          </button>
        )}
      </td>
    </tr>
  );
}

function InvitationRow({ inv, onChanged }: { inv: Invitation; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      const r = await fn() as Mailed | undefined;
      setNote(r?.dev_link ? `Sent. Link: ${r.dev_link}` : done ?? null);
      onChanged();
    } catch (e) {
      setNote(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <tr>
      <td>{inv.email}{note && <div className="muted members-sub" style={{ overflowWrap: 'anywhere' }}>{note}</div>}</td>
      <td>{ROLE_INFO[inv.role].label}</td>
      <td className="muted">{inv.invited_by ?? '—'}</td>
      <td><StatusBadge value={inv.status === 'pending' ? 'acknowledged' : 'paused'} label={inv.status === 'pending' ? `Expires ${formatTime(inv.expires_at)}` : 'Expired'} /></td>
      <td className="num">
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn--sm" disabled={busy} onClick={() => void run(() => accounts.resendInvite(inv.id), 'Sent again.')}>Resend</button>
          <button className="btn btn--sm btn--danger" disabled={busy}
            onClick={() => confirm(`Cancel the invitation to ${inv.email}?`) && void run(() => accounts.revokeInvite(inv.id))}>Cancel</button>
        </div>
      </td>
    </tr>
  );
}

export default function MembersPage() {
  const { me, can, refresh } = useAuth();
  const manage = can(PERM.manageMembers);
  const { data, error, reload } = usePolling(() => accounts.members(), 30000);
  const changed = () => { void reload(); void refresh(); };
  const counts = ROLES.map((r) => (data?.members ?? []).filter((m) => m.role === r).length);

  return (
    <>
      <PageHeader title="Members & Roles"
        description={`People in ${me?.org.name ?? 'your organization'} and what each role can do. Everyone sees the same cameras, events and settings of the organization.`} />
      {error && <p className="notice notice--error">{error}</p>}

      <section className="role-cards" aria-label="Roles">
        {ROLES.map((r, i) => (
          <div key={r} className="card role-card">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h2 className="section-title" style={{ margin: 0 }}>{ROLE_INFO[r].label}</h2>
              <span className="muted">{counts[i]} {counts[i] === 1 ? 'person' : 'people'}</span>
            </div>
            <p className="role-card__summary">{ROLE_INFO[r].summary}</p>
            <p className="muted role-card__detail">{ROLE_INFO[r].detail}</p>
          </div>
        ))}
      </section>

      <div className="stack">
        {manage && (
          <section className="card members-section">
            <h2 className="section-title">Invite someone</h2>
            <p className="muted" style={{ marginTop: -6 }}>They get an email with a link to create their account (or join with the one they have). Opening the link verifies their email.</p>
            <InviteForm onSent={changed} />
          </section>
        )}

        <section className="card members-section">
          <h2 className="section-title">Members ({data?.members.length ?? 0})</h2>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Name</th><th>Role</th><th>Email status</th><th>Last sign-in</th><th>Joined</th><th /></tr></thead>
              <tbody>
                {(data?.members ?? []).map((m) => (
                  <MemberRow key={m.id} m={m} self={m.id === me?.user.id} manage={manage} onChanged={changed} />
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {manage && (data?.invitations.length ?? 0) > 0 && (
          <section className="card members-section">
            <h2 className="section-title">Pending invitations</h2>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Email</th><th>Role</th><th>Invited by</th><th>Status</th><th /></tr></thead>
                <tbody>{data!.invitations.map((inv) => <InvitationRow key={inv.id} inv={inv} onChanged={changed} />)}</tbody>
              </table>
            </div>
          </section>
        )}

        <section className="card members-section">
          <h2 className="section-title">What each role can do</h2>
          <p className="muted" style={{ marginTop: -6 }}>
            {can(PERM.manageRoles)
              ? 'Tick or untick what members and viewers may do. Admins can always do everything; managing people and roles stays with admins.'
              : 'Only admins can change these.'}
          </p>
          <RolesTable editable={can(PERM.manageRoles)} />
        </section>
      </div>
    </>
  );
}
