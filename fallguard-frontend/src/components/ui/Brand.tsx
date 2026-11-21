import './brand.css';

/**
 * FallGuard Vision branding (files in public/brand). Every logo has a light and a dark
 * version; CSS shows the one that matches the theme (Settings → Appearance, or the system).
 */

const LOGOS = {
  horizontal: { light: '/brand/logo-horizontal-vision-light.svg', dark: '/brand/logo-horizontal-vision-dark.svg', w: 274, h: 72 },
  stacked: { light: '/brand/logo-stacked-light.svg', dark: '/brand/logo-stacked-dark.svg', w: 179, h: 144 },
} as const;

/** The FallGuard Vision logo. height in px; the width follows. */
export function BrandLogo({ variant = 'horizontal', height = 36, className = '' }: {
  variant?: keyof typeof LOGOS; height?: number; className?: string;
}) {
  const l = LOGOS[variant];
  const width = Math.round((l.w / l.h) * height);
  return (
    <span className={`brand ${className}`} role="img" aria-label="FallGuard Vision">
      <img src={l.light} alt="" width={width} height={height} className="brand__img brand__img--light" />
      <img src={l.dark} alt="" width={width} height={height} className="brand__img brand__img--dark" />
    </span>
  );
}

/** The C4 mark on its own (small spaces). */
export function BrandMark({ size = 32, className = '' }: { size?: number; className?: string }) {
  return <img src="/brand/icon-c4.svg" alt="FallGuard Vision" width={size} height={size} className={`brand-mark ${className}`} />;
}

/** "Powered by Xcelerate Industries", the (mock) company behind FallGuard. */
export function PoweredBy({ className = '' }: { className?: string }) {
  return (
    <span className={`powered-by ${className}`}>
      <span className="powered-by__text">Powered by</span>
      <img src="/brand/xcelerate-industries.jpeg" alt="Xcelerate Industries" width={80} height={20} className="powered-by__logo" />
    </span>
  );
}

/** Full-screen loading view: the stacked logo, gently pulsing. */
export function BrandLoader({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="brand-loader" role="status" aria-live="polite">
      <BrandLogo variant="stacked" height={120} className="brand-loader__logo" />
      <span className="brand-loader__bar" aria-hidden="true"><span /></span>
      <span className="visually-hidden">{label}</span>
    </div>
  );
}
