import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../../components/ui/PageHeader';
import { accounts } from '../../services/api/accounts';
import { formatTime } from '../../lib/format';
import { useAuth } from '../auth/AuthContext';
import { ROLE_INFO } from '../members/MembersPage';

type Msg = { ok: boolean; text: string } | null;
const errorText = (e: unknown) => (e instanceof Error ? e.message.charAt(0).toUpperCase() + e.message.slice(1) : String(e));
const Notice = ({ m }: { m: Msg }) => (m ? <p className={`notice${m.ok ? '' : ' notice--error'}`} role="status">{m.text}</p> : null);

function Profile() {
  const { me, refresh } = useAuth();
  const [form, setForm] = useState({ first_name: me?.user.first_name ?? '', last_name: me?.user.last_name ?? '', phone: me?.user.phone ?? '' });
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await accounts.updateMe({ ...form, phone: form.phone.trim() || null });
      await refresh();
      setMsg({ ok: true, text: 'Profile saved.' });
    } catch (err) {
      setMsg({ ok: false, text: errorText(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card" style={{ padding: 20 }}>
      <h2 className="section-title">Profile</h2>
      <Notice m={msg} />
      <form onSubmit={submit} className="stack" style={{ gap: 12 }}>
        <div className="form-grid">
          <label className="field">First name<input value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} required maxLength={60} autoComplete="given-name" /></label>
          <label className="field">Last name<input value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} required maxLength={60} autoComplete="family-name" /></label>
        </div>
        <label className="field">Email<input value={me?.user.email ?? ''} disabled />
          <small>Your sign-in. One account per email; it can't be changed here.</small></label>
        <label className="field">Mobile number (for SMS alerts)
          <input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+14165550123" autoComplete="tel" />
          <small>International format. Admins can then add you as an SMS recipient.</small>
        </label>
        <div><button className="btn btn--primary" disabled={busy}>Save profile</button></div>
      </form>
    </section>
  );
}

function Password() {
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (form.next !== form.confirm) {
      setMsg({ ok: false, text: 'The two new passwords are different.' });
      return;
    }
    setBusy(true);
    try {
      await accounts.changePassword(form.current, form.next);
      setForm({ current: '', next: '', confirm: '' });
      setMsg({ ok: true, text: 'Password changed. Other devices were signed out.' });
    } catch (err) {
      setMsg({ ok: false, text: errorText(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card" style={{ padding: 20 }}>
      <h2 className="section-title">Password</h2>
      <Notice m={msg} />
      <form onSubmit={submit} className="stack" style={{ gap: 12 }}>
        <label className="field">Current password<input type="password" value={form.current} onChange={(e) => setForm({ ...form, current: e.target.value })} required autoComplete="current-password" /></label>
        <div className="form-grid">
          <label className="field">New password<input type="password" value={form.next} onChange={(e) => setForm({ ...form, next: e.target.value })} required minLength={10} maxLength={72} autoComplete="new-password" />
            <small>At least 10 characters, with letters and a number or symbol.</small></label>
          <label className="field">Confirm new password<input type="password" value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} required autoComplete="new-password" /></label>
        </div>
        <div><button className="btn btn--primary" disabled={busy}>Change password</button></div>
      </form>
    </section>
  );
}

export default function AccountPage() {
  const { me, signOut } = useAuth();
  const navigate = useNavigate();
  const [msg, setMsg] = useState<Msg>(null);
  if (!me) return null;
  if (me.user.is_guest) {
    return (
      <>
        <PageHeader title="Demo access" description={`View-only access to ${me.org.name}`} />
        <p className="notice">You're looking around with a demo link, without an account. It works until{' '}
          {me.user.access_until ? new Date(me.user.access_until).toLocaleString() : 'it is turned off'}.</p>
        <button className="btn" onClick={async () => { await signOut(); navigate('/login', { replace: true }); }}>Leave the demo</button>
      </>
    );
  }

  return (
    <>
      <PageHeader title="My account" description={`Signed in as ${me.user.email}${me.user.last_login_at ? ` · last sign-in ${formatTime(me.user.last_login_at)}` : ''}`} />
      <div className="stack" style={{ maxWidth: 720 }}>
        <section className="card" style={{ padding: 20 }}>
          <h2 className="section-title">Organization</h2>
          <p style={{ margin: 0 }}><strong>{me.org.name}</strong> · {ROLE_INFO[me.role].label}</p>
          <p className="muted" style={{ margin: '4px 0 0' }}>{ROLE_INFO[me.role].detail}</p>
          {me.orgs.length > 1 && <p className="muted">You belong to {me.orgs.length} organizations: switch from the account menu (top right).</p>}
        </section>
        <Profile />
        <Password />
        <section className="card" style={{ padding: 20 }}>
          <h2 className="section-title">Sessions</h2>
          <Notice m={msg} />
          <div className="row">
            <button className="btn" onClick={async () => { await signOut(); navigate('/login', { replace: true }); }}>Sign out</button>
            <button className="btn" onClick={async () => {
              try { await accounts.logoutAll(); await signOut(); navigate('/login', { replace: true }); } catch (e) { setMsg({ ok: false, text: errorText(e) }); }
            }}>Sign out everywhere</button>
            <button className="btn btn--danger" onClick={async () => {
              if (!confirm(`Leave ${me.org.name}? You lose access to it until someone invites you again.`)) return;
              try { await accounts.leaveOrg(); await signOut(); navigate('/login?left=1', { replace: true }); } catch (e) { setMsg({ ok: false, text: errorText(e) }); }
            }}>Leave organization</button>
          </div>
        </section>
      </div>
    </>
  );
}
