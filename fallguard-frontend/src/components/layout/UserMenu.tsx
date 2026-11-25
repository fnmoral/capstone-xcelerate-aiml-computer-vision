import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../features/auth/AuthContext';
import { accounts } from '../../services/api/accounts';
import { Icon } from '../ui/Icon';

const ROLE_LABEL: Record<string, string> = { admin: 'Admin', member: 'Member', viewer: 'Viewer' };

/** Signed-in user: name, organization and role, switch organization, account, sign out. */
export function UserMenu() {
  const { me, signOut, refresh } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const escape = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  if (!me) return null;
  const name = `${me.user.first_name} ${me.user.last_name}`.trim() || me.user.email;
  const initials = (me.user.first_name[0] ?? '') + (me.user.last_name[0] ?? '') || me.user.email[0];

  const switchTo = async (orgId: string) => {
    setError(null);
    try {
      await accounts.switchOrg(orgId);
      await refresh();
      setOpen(false);
      navigate('/', { replace: true });
      window.location.reload(); // every page reloads its data for the other organization
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="notif" ref={ref}>
      <button className="header__icon-btn user-btn" aria-expanded={open} aria-controls="user-panel"
        aria-label={`Account: ${name}, ${me.org.name}`} onClick={() => setOpen((o) => !o)}>
        <span className="user-avatar" aria-hidden="true">{initials.toUpperCase()}</span>
        <span className="user-btn__text">
          <span className="user-btn__name">{name}</span>
          <span className="user-btn__org">{me.org.name}</span>
        </span>
      </button>
      {open && (
        <div className="notif__panel card user-panel" id="user-panel" role="region" aria-label="Account">
          <div className="user-panel__who">
            <strong>{name}</strong>
            {!me.user.is_guest && <span className="muted">{me.user.email}</span>}
            <span className="muted">{me.org.name} · {me.user.is_guest
              ? (me.permissions.includes('alerts.manage') ? 'Temporary access' : 'Temporary access, view-only')
              : ROLE_LABEL[me.role] ?? me.role}</span>
            {me.user.is_guest && me.user.access_until && (
              <span className="muted">Until {new Date(me.user.access_until).toLocaleString()}</span>
            )}
          </div>
          {error && <p className="notice notice--error">{error}</p>}
          {me.orgs.length > 1 && (
            <div className="user-panel__orgs">
              <p className="nav__heading" style={{ margin: '0 0 4px' }}>Switch organization</p>
              {me.orgs.filter((o) => o.id !== me.org.id).map((o) => (
                <button key={o.id} className="user-panel__item" onClick={() => void switchTo(o.id)}>
                  {o.name} <span className="muted">· {ROLE_LABEL[o.role] ?? o.role}</span>
                </button>
              ))}
            </div>
          )}
          {!me.user.is_guest && <Link to="/account" className="user-panel__item" onClick={() => setOpen(false)}><Icon name="user" size={16} /> My account</Link>}
          {me.user.is_guest && <Link to="/account" className="user-panel__item" onClick={() => setOpen(false)}><Icon name="user" size={16} /> {me.user.visitor_name ? 'Change my name' : 'Add my name'}</Link>}
          {me.permissions.includes('members.view') && <Link to="/members" className="user-panel__item" onClick={() => setOpen(false)}><Icon name="users" size={16} /> Members &amp; roles</Link>}
          <button className="user-panel__item" onClick={async () => { await signOut(); navigate('/login', { replace: true }); }}>
            <Icon name="logout" size={16} /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}
