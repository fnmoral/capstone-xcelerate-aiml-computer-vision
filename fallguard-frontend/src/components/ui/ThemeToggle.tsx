import { effectiveTheme, useUiStore } from '../../store/uiStore';
import { Icon } from './Icon';
import './theme-toggle.css';

/** Is the page dark right now (the chosen theme, or the system's when it's "system")? */
function isDark(theme: string): boolean {
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

/**
 * Light / dark switch for pages without the app menu (sign-in pages, public pages).
 * Switching saves this browser's own choice; Settings → Appearance can go back to the
 * organization's default.
 */
export function ThemeToggle({ className = '' }: { className?: string }) {
  const theme = useUiStore(effectiveTheme);
  const setTheme = useUiStore((s) => s.setTheme);
  const dark = isDark(theme);
  return (
    <button type="button" className={`theme-toggle ${className}`} onClick={() => setTheme(dark ? 'light' : 'dark')}
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'} title={dark ? 'Light mode' : 'Dark mode'}>
      <Icon name={dark ? 'sun' : 'moon'} size={18} />
    </button>
  );
}
