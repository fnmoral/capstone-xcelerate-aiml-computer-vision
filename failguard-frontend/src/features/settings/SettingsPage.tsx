import { PageHeader } from '../../components/ui/PageHeader';
import { useUiStore, type Theme } from '../../store/uiStore';

const THEMES: Theme[] = ['system', 'light', 'dark'];

export default function SettingsPage() {
  const { theme, setTheme } = useUiStore();
  return (
    <>
      <PageHeader title="Settings" description="Account, organization, notification and appearance preferences." />
      <section className="card" style={{ padding: 20, maxWidth: 560 }}>
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>Appearance</h2>
        <div role="radiogroup" aria-label="Theme" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {THEMES.map((t) => (
            <button key={t} role="radio" aria-checked={theme === t} onClick={() => setTheme(t)}
              className={`btn${theme === t ? ' btn--primary' : ''}`} style={{ textTransform: 'capitalize' }}>{t}</button>
          ))}
        </div>
        <p style={{ color: 'var(--text-muted)', fontSize: 14, marginBottom: 0 }}>
          Account, organization and notification settings are planned for later sprints.
        </p>
      </section>
    </>
  );
}
