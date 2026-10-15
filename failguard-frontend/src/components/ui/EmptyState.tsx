import { Icon } from './Icon';
import './ui.css';

export function EmptyState({ icon, title, body }: { icon: string; title: string; body: string }) {
  return (
    <div className="empty">
      <span className="empty__icon"><Icon name={icon} size={26} /></span>
      <h2 className="empty__title">{title}</h2>
      <p className="empty__body">{body}</p>
    </div>
  );
}
