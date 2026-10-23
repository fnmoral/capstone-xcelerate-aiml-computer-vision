import { env } from '../../config/env';
import './Footer.css';

export function Footer() {
  return (
    <footer className="footer" role="contentinfo">
      <span>FailGuard Vision · Fanshawe College AIM1 Capstone</span>
      <span className="footer__meta">Prototype v{env.appVersion} · Not for operational use</span>
    </footer>
  );
}
