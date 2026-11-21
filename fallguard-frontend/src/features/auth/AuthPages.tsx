import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { accounts, type InvitationInfo, type Mailed } from '../../services/api/accounts';
import { ApiError } from '../../services/api/client';
import { useAuth } from './AuthContext';
import { BrandLogo, PoweredBy } from '../../components/ui/Brand';
import { ThemeToggle } from '../../components/ui/ThemeToggle';
import './auth.css';

const MIN_PASSWORD = 10;

function errorText(e: unknown) {
  return e instanceof Error ? e.message.charAt(0).toUpperCase() + e.message.slice(1) : String(e);
}

/** Centered card with the logo, used by every sign-in page. */
function AuthCard({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => { document.title = `${title} · FallGuard Vision`; }, [title]);
  return (
    <main className="auth-page">
      <ThemeToggle className="theme-toggle--corner" />
      <div className="auth-card card">
        <div className="auth-brand"><BrandLogo height={44} /></div>
        <h1 className="auth-title">{title}</h1>
        {subtitle && <p className="auth-subtitle">{subtitle}</p>}
        {children}
      </div>
      {footer && <p className="auth-footer">{footer}</p>}
      <PoweredBy className="auth-powered" />
    </main>
  );
}

/** Link shown when the server has no mail provider and is set to show links (demos). */
function DevLink({ mailed }: { mailed: Mailed | null }) {
  if (!mailed) return null;
  if (mailed.dev_link) {
    return (
      <p className="notice">No email server is set up, so here is the link from the email:{' '}
        <a href={mailed.dev_link}>open it</a>.</p>
    );
  }
  if (mailed.email_delivery === 'logged') {
    return <p className="notice">No email server is set up yet: the link was written to the server log (ask your administrator).</p>;
  }
  return null;
}

function PasswordField({ value, onChange, label = 'Password', autoComplete = 'new-password', hint = true }: {
  value: string; onChange: (v: string) => void; label?: string; autoComplete?: string; hint?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <label className="field">{label}
      <span className="auth-password">
        <input type={show ? 'text' : 'password'} value={value} onChange={(e) => onChange(e.target.value)} required
          autoComplete={autoComplete} minLength={autoComplete === 'new-password' ? MIN_PASSWORD : undefined} maxLength={72} />
        <button type="button" className="btn btn--sm" onClick={() => setShow(!show)} aria-pressed={show}>{show ? 'Hide' : 'Show'}</button>
      </span>
      {hint && <small>At least {MIN_PASSWORD} characters, with letters and a number or symbol.</small>}
    </label>
  );
}

/** Where to go after signing in: ?next= if it's a page of this app. */
function nextPath(params: URLSearchParams) {
  const next = params.get('next') ?? '';
  return next.startsWith('/') && !next.startsWith('//') ? next : '/live';
}

export function LoginPage() {
  const { me, refresh } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [email, setEmail] = useState(params.get('email') ?? '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unverified, setUnverified] = useState(false);
  const [mailed, setMailed] = useState<Mailed | null>(null);

  if (me) return <Navigate to={nextPath(params)} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setUnverified(false);
    try {
      await accounts.login(email, password);
      await refresh();
      navigate(nextPath(params), { replace: true });
    } catch (err) {
      setError(errorText(err));
      setUnverified(err instanceof ApiError && err.code === 'email_not_verified');
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    try {
      setMailed(await accounts.resendVerification(email));
      setError(null);
      setUnverified(false);
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <AuthCard title="Sign in" subtitle="Monitor falls across your facility."
      footer={<>New to FallGuard? <Link to="/signup">Create an organization</Link></>}>
      {params.get('reset') && <p className="notice">Password changed. Sign in with your new password.</p>}
      {params.get('left') && <p className="notice">You left the organization.</p>}
      {error && <p className="notice notice--error" role="alert">{error}</p>}
      {unverified && <p><button className="btn btn--sm" onClick={resend}>Send the verification email again</button></p>}
      {mailed && <p className="notice">If the address needs verifying, a new link is on its way. Check your inbox.</p>}
      <DevLink mailed={mailed} />
      <form onSubmit={submit} className="stack auth-form">
        <label className="field">Work email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" autoFocus />
        </label>
        <PasswordField value={password} onChange={setPassword} autoComplete="current-password" hint={false} />
        <button className="btn btn--primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
      <p className="auth-links"><Link to={`/forgot-password${email ? `?email=${encodeURIComponent(email)}` : ''}`}>Forgot your password?</Link></p>
    </AuthCard>
  );
}

export function SignupPage() {
  const { me, refresh } = useAuth();
  const navigate = useNavigate();
  const [verify, setVerify] = useState(true);
  useEffect(() => { accounts.config().then((c) => setVerify(c.email_verification)).catch(() => undefined); }, []);
  const [form, setForm] = useState({ org_name: '', first_name: '', last_name: '', email: '', password: '' });
  const [confirm, setConfirm] = useState('');
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<(Mailed & { email: string }) | null>(null);

  if (me) return <Navigate to="/live" replace />;
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (form.password !== confirm) {
      setError('The two passwords are different.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await accounts.signup(form);
      if (r.signed_in) { // email verification is off on this server: straight in
        await refresh();
        navigate('/', { replace: true });
        return;
      }
      setDone(r);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <AuthCard title="Check your email" subtitle={<>We sent a verification link to <strong>{done.email}</strong>. Open it to finish setting up your account.</>}
        footer={<Link to="/login">Back to sign in</Link>}>
        <DevLink mailed={done} />
        <p className="muted">Didn't get it? Check spam, or{' '}
          <button className="btn btn--sm" onClick={async () => setDone({ ...done, ...(await accounts.resendVerification(done.email)) })}>send it again</button></p>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Create your organization" subtitle="You'll be its admin and can invite your team afterwards."
      footer={<>Already have an account? <Link to="/login">Sign in</Link></>}>
      {error && <p className="notice notice--error" role="alert">{error}</p>}
      <form onSubmit={submit} className="stack auth-form">
        <label className="field">Organization name
          <input value={form.org_name} onChange={set('org_name')} required maxLength={120} autoComplete="organization" autoFocus
            placeholder="e.g. Maple Grove Care Home" />
        </label>
        <div className="form-grid">
          <label className="field">First name
            <input value={form.first_name} onChange={set('first_name')} required maxLength={60} autoComplete="given-name" />
          </label>
          <label className="field">Last name
            <input value={form.last_name} onChange={set('last_name')} required maxLength={60} autoComplete="family-name" />
          </label>
        </div>
        <label className="field">Work email
          <input type="email" value={form.email} onChange={set('email')} required autoComplete="email" />
          <small>One account per email.{verify ? " You'll need to verify it." : ''}</small>
        </label>
        <PasswordField value={form.password} onChange={(v) => setForm({ ...form, password: v })} />
        <PasswordField value={confirm} onChange={setConfirm} label="Confirm password" hint={false} />
        <label className="auth-check">
          <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} required />
          <span>I'm authorized to set up FallGuard for this organization.</span>
        </label>
        <button className="btn btn--primary" disabled={busy}>{busy ? 'Creating…' : 'Create organization'}</button>
      </form>
    </AuthCard>
  );
}

export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [state, setState] = useState<'working' | 'ok' | 'error'>('working');
  const [error, setError] = useState('');
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // StrictMode runs effects twice; the link works only once
    started.current = true;
    const token = params.get('token') ?? '';
    accounts.verifyEmail(token)
      .then(async () => {
        setState('ok');
        if (await refresh()) window.setTimeout(() => navigate('/live', { replace: true }), 1500);
      })
      .catch((e) => { setState('error'); setError(errorText(e)); });
  }, [params, refresh, navigate]);

  return (
    <AuthCard title={state === 'ok' ? 'Email verified' : state === 'error' ? 'Link not valid' : 'Verifying…'}
      footer={<Link to="/login">Go to sign in</Link>}>
      {state === 'ok' && <p className="notice">Thanks! Your email is verified. Opening FallGuard…</p>}
      {state === 'error' && <p className="notice notice--error">{error}</p>}
    </AuthCard>
  );
}

export function ForgotPasswordPage() {
  const [params] = useSearchParams();
  const [email, setEmail] = useState(params.get('email') ?? '');
  const [busy, setBusy] = useState(false);
  const [mailed, setMailed] = useState<Mailed | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setMailed(await accounts.forgotPassword(email));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Reset your password" subtitle="We'll email you a link to choose a new one."
      footer={<Link to="/login">Back to sign in</Link>}>
      {error && <p className="notice notice--error">{error}</p>}
      {mailed ? (
        <>
          <p className="notice">If an account exists for <strong>{email}</strong>, a reset link is on its way. It expires in 1 hour.</p>
          <DevLink mailed={mailed} />
        </>
      ) : (
        <form onSubmit={submit} className="stack auth-form">
          <label className="field">Work email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" autoFocus />
          </label>
          <button className="btn btn--primary" disabled={busy}>{busy ? 'Sending…' : 'Send reset link'}</button>
        </form>
      )}
    </AuthCard>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      setError('The two passwords are different.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await accounts.resetPassword(params.get('token') ?? '', password);
      navigate('/login?reset=1', { replace: true });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Choose a new password" subtitle="You'll be signed out of every other device."
      footer={<Link to="/forgot-password">Need a new link?</Link>}>
      {error && <p className="notice notice--error">{error}</p>}
      <form onSubmit={submit} className="stack auth-form">
        <PasswordField value={password} onChange={setPassword} label="New password" />
        <PasswordField value={confirm} onChange={setConfirm} label="Confirm new password" hint={false} />
        <button className="btn btn--primary" disabled={busy}>{busy ? 'Saving…' : 'Set password'}</button>
      </form>
    </AuthCard>
  );
}

const ROLE_TEXT: Record<string, string> = {
  admin: 'Admin: full control, including members and roles',
  member: 'Member: can operate and configure, but not manage members',
  viewer: 'Viewer: read-only access to cameras, reports and logs',
};

export function InvitePage() {
  const { token = '' } = useParams();
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [info, setInfo] = useState<InvitationInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState({ first_name: '', last_name: '', password: '' });
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    accounts.invitation(token).then(setInfo).catch((e) => setLoadError(errorText(e)));
  }, [token]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!info?.account_exists && form.password !== confirm) {
      setError('The two passwords are different.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await accounts.acceptInvitation(token, info?.account_exists ? { password: form.password } : form);
      await refresh();
      navigate('/live', { replace: true });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (loadError) {
    return <AuthCard title="Invitation not valid" footer={<Link to="/login">Go to sign in</Link>}>
      <p className="notice notice--error">{loadError}</p></AuthCard>;
  }
  if (!info) return <AuthCard title="Loading invitation…"><p className="muted">One moment…</p></AuthCard>;

  return (
    <AuthCard title={`Join ${info.org_name}`}
      subtitle={<>{info.invited_by} invited <strong>{info.email}</strong> to FallGuard.</>}>
      <p className="notice">{ROLE_TEXT[info.role] ?? info.role}</p>
      {error && <p className="notice notice--error" role="alert">{error}</p>}
      <form onSubmit={submit} className="stack auth-form">
        {info.account_exists ? (
          <>
            <p className="muted" style={{ margin: 0 }}>You already have a FallGuard account. Enter its password to join.</p>
            <PasswordField value={form.password} onChange={(v) => setForm({ ...form, password: v })} autoComplete="current-password" hint={false} />
          </>
        ) : (
          <>
            <div className="form-grid">
              <label className="field">First name
                <input value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} required maxLength={60} autoComplete="given-name" autoFocus />
              </label>
              <label className="field">Last name
                <input value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} required maxLength={60} autoComplete="family-name" />
              </label>
            </div>
            <label className="field">Email<input value={info.email} disabled /></label>
            <PasswordField value={form.password} onChange={(v) => setForm({ ...form, password: v })} />
            <PasswordField value={confirm} onChange={setConfirm} label="Confirm password" hint={false} />
          </>
        )}
        <button className="btn btn--primary" disabled={busy}>{busy ? 'Joining…' : 'Accept invitation'}</button>
      </form>
    </AuthCard>
  );
}

/** Temporary access link: signs this browser in as a view-only visitor, no account needed. */
export function DemoPage() {
  const { token = '' } = useParams();
  const { me, refresh } = useAuth();
  const navigate = useNavigate();
  const [info, setInfo] = useState<{ org_name: string; label: string; expires_at: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  const enter = async () => {
    setBusy(true);
    try {
      await accounts.demoEnter(token);
      await refresh();
      navigate('/', { replace: true });
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    accounts.demoInfo(token).then((i) => {
      setInfo(i);
      // Not signed in: go straight in. Signed in with an account: ask first (it would sign them out).
      if (!me) void enter();
    }).catch((e) => setError(errorText(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  if (error) {
    return <AuthCard title="Link not valid" footer={<Link to="/login">Go to sign in</Link>}>
      <p className="notice notice--error">{error}</p></AuthCard>;
  }
  return (
    <AuthCard title={info ? info.org_name : 'Opening…'}
      subtitle={info ? <>View-only access until {new Date(info.expires_at).toLocaleString()}. No account needed.</> : undefined}>
      {me && info && !busy ? (
        <>
          <p className="notice">You're signed in as {me.user.email}. Continuing signs you out of your account in this browser.</p>
          <div className="row">
            <button className="btn btn--primary" onClick={() => void enter()}>Continue with temporary access</button>
            <button className="btn" onClick={() => navigate('/', { replace: true })}>Stay signed in</button>
          </div>
        </>
      ) : <p className="muted">One moment…</p>}
    </AuthCard>
  );
}
