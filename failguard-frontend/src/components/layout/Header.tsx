import { Link } from 'react-router-dom';
import { useUiStore } from '../../store/uiStore';
import { Icon } from '../ui/Icon';
import './Header.css';

export function Header() {
  const { navOpen, toggleNav } = useUiStore();
  return (
    <header className="header" role="banner">
      <button className="header__menu" onClick={toggleNav}
        aria-label={navOpen ? 'Close navigation' : 'Open navigation'}
        aria-expanded={navOpen} aria-controls="primary-nav">
        <Icon name={navOpen ? 'close' : 'menu'} />
      </button>
      <Link to="/" className="header__brand" aria-label="FailGuard Vision home">
        <span className="header__logo"><Icon name="shield" size={18} /></span>
        <span className="header__name">FailGuard <strong>Vision</strong></span>
      </Link>
      <div className="header__spacer" />
      <div className="header__actions">
        <button className="header__icon-btn" aria-label="Notifications"><Icon name="bell" /></button>
        <button className="header__icon-btn" aria-label="Account"><Icon name="user" /></button>
      </div>
    </header>
  );
}
