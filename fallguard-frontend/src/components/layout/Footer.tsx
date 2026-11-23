import { env } from '../../config/env';
import { PoweredBy } from '../ui/Brand';
import './Footer.css';

export function Footer() {
  return (
    <footer className="footer" role="contentinfo">
      <span>FallGuard Vision · Fanshawe College AIM1 Capstone</span>
      <span className="footer__meta">Prototype v{env.appVersion} · Not for operational use</span>
      <PoweredBy className="footer__powered" />
    </footer>
  );
}
