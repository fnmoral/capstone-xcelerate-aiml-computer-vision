import { Link } from "react-router-dom";
import { useUiStore } from "../../store/uiStore";
import { api } from "../../services/api/fallguard";
import { usePolling } from "../../services/api/usePolling";
import { Icon } from "../ui/Icon";
import { NotificationsMenu } from "./NotificationsMenu";
import { UserMenu } from "./UserMenu";
import { BrandLogo, BrandMark } from "../ui/Brand";
import "./Header.css";

export function Header() {
  const { navOpen, navPinned, toggleNav, togglePinned } = useUiStore();
  const { data: stats } = usePolling(() => api.stats(), 5000);
  const active = stats?.active_incidents ?? 0;

  return (
    <header className="header" role="banner">
      <button
        className="header__menu"
        onClick={navPinned ? togglePinned : toggleNav}
        aria-label={navOpen || navPinned ? "Close navigation" : "Open navigation"}
        aria-expanded={navOpen || navPinned}
        aria-controls="primary-nav"
      >
        <Icon name={navOpen || navPinned ? "close" : "menu"} />
      </button>
      <Link to="/" className="header__brand" aria-label="FallGuard Vision home">
        <BrandLogo height={38} className="header__logo" />
        <BrandMark size={32} className="header__mark" />
      </Link>
      <div className="header__spacer" />
      {active > 0 && (
        <Link
          to="/events?status=active"
          className="header__alert"
          role="status"
        >
          {active === 1 ? "1 person down" : `${active} people down`}
        </Link>
      )}
      <div className="header__actions">
        <NotificationsMenu />
        <UserMenu />
      </div>
    </header>
  );
}
