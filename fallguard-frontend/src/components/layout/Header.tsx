import { Link } from 'react-router-dom';
import { useUiStore } from '../../store/uiStore';
import { api } from '../../services/api/fallguard';
import { usePolling } from '../../services/api/usePolling';
import { Icon } from '../ui/Icon';
import './Header.css';

export function Header() {
  const { navOpen, toggleNav } = useUiStore();
  const { data: stats } = usePolling(() => api.stats(), 5000);
  const open = stats?.open_alerts ?? 0;
  const active = stats?.active_incidents ?? 0;

  return (
    <header className="header" role="banner">
      <button className="header__menu" onClick={toggleNav}
        aria-label={navOpen ? 'Close navigation' : 'Open navigation'}
        aria-expanded={navOpen} aria-controls="primary-nav">
        <Icon name={navOpen ? 'close' : 'menu'} />
      </button>
      <Link to="/" className="header__brand" aria-label="FallGuard Vision home">
        <span className="header__logo"><Icon name="shield" size={18} /></span>
        <span className="header__name">FallGuard <strong>Vision</strong></span>
      </Link>
      <div className="header__spacer" />
      {active > 0 && (
        <Link to="/events?status=active" className="header__alert" role="status">
          {active === 1 ? '1 person down' : `${active} people down`}
        </Link>
      )}
      <div className="header__actions">
        <Link to="/events" className="header__icon-btn header__bell"
          aria-label={open ? `${open} open alert${open > 1 ? 's' : ''}` : 'No open alerts'}>
          <Icon name="bell" />
          {open > 0 && <span className="header__count">{open > 99 ? '99+' : open}</span>}
        </Link>
        <Link to="/settings" className="header__icon-btn" aria-label="Settings"><Icon name="user" /></Link>
      </div>
    </header>
  );
}
