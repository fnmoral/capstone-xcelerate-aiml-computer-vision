import { NavLink } from 'react-router-dom';
import { NAV_ITEMS, SECTION_LABELS, type NavSection } from '../../config/navigation';
import { useUiStore } from '../../store/uiStore';
import { Icon } from '../ui/Icon';
import './Navigation.css';

const SECTIONS: NavSection[] = ['monitor', 'manage', 'system'];

export function Navigation() {
  const { navOpen, navCollapsed, closeNav, toggleCollapsed } = useUiStore();
  const cls = ['nav', navOpen && 'nav--open', navCollapsed && 'nav--collapsed'].filter(Boolean).join(' ');

  return (
    <>
      <div className={`nav-scrim${navOpen ? ' nav-scrim--show' : ''}`} onClick={closeNav} aria-hidden="true" />
      <nav id="primary-nav" className={cls} aria-label="Primary">
        {SECTIONS.map((section) => (
          <div className="nav__group" key={section}>
            <p className="nav__heading">{SECTION_LABELS[section]}</p>
            <ul>
              {NAV_ITEMS.filter((i) => i.section === section).map((item) => (
                <li key={item.path}>
                  <NavLink to={item.path} onClick={closeNav} title={navCollapsed ? item.label : undefined}
                    className={({ isActive }) => `nav__link${isActive ? ' nav__link--active' : ''}`}>
                    <Icon name={item.icon} />
                    <span className="nav__label">{item.label}</span>
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <button className="nav__collapse" onClick={toggleCollapsed}
          aria-label={navCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          <Icon name={navCollapsed ? 'expand' : 'collapse'} />
          <span className="nav__label">Collapse</span>
        </button>
      </nav>
    </>
  );
}
