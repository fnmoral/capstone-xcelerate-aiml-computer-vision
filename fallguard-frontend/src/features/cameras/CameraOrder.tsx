import { useEffect, useState, type DragEvent } from 'react';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { api } from '../../services/api/fallguard';
import type { Camera } from '../../types/domain';

/**
 * The order cameras are shown in Live View and in fall-event videos. Drag a name, or use
 * the arrows (keyboard / touch); a new order is saved straight away for everyone.
 */
export function CameraOrder({ cameras, onSaved }: { cameras: Camera[]; onSaved: () => unknown }) {
  const [order, setOrder] = useState(cameras.map((c) => c.id));
  const [dragging, setDragging] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const byId = Object.fromEntries(cameras.map((c) => [c.id, c]));
  const serverOrder = cameras.map((c) => c.id).join();

  // Follow the server's list (cameras added / removed), but not during a drag or a save:
  // that would briefly show the old order again.
  useEffect(() => {
    if (!dragging && !saving) setOrder(serverOrder ? serverOrder.split(',') : []);
  }, [serverOrder, dragging, saving]);

  const save = async (next: string[]) => {
    setOrder(next);
    if (next.join() === serverOrder) return;
    setStatus('Saving…');
    setSaving(true);
    try {
      await api.setCameraOrder(next);
      await onSaved();
      setStatus('Order saved');
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  const move = (from: number, to: number) => {
    if (to < 0 || to >= order.length) return order;
    const next = [...order];
    next.splice(to, 0, next.splice(from, 1)[0]);
    return next;
  };

  const over = (e: DragEvent, id: string) => {
    e.preventDefault();
    if (!dragging || dragging === id) return;
    setOrder((o) => move(o.indexOf(dragging), o.indexOf(id)));
  };

  if (cameras.length < 2) return null;
  return (
    <section className="card cams-order">
      <div className="cams-order__head">
        <h2 className="section-title">Camera order</h2>
        <span className="muted cams-order__status" role="status">{status ?? 'Drag to change the order in Live View and in fall-event videos.'}</span>
      </div>
      <ol className="cams-order__list">
        {order.filter((id) => byId[id]).map((id, i) => (
          <li key={id} draggable className={`cams-order__item${dragging === id ? ' is-dragging' : ''}`}
            onDragStart={(e) => { setDragging(id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); }}
            onDragOver={(e) => over(e, id)}
            onDrop={(e) => { e.preventDefault(); }}
            onDragEnd={() => { setDragging(null); void save(order); }}>
            <span className="cams-order__handle" aria-hidden="true">⠿</span>
            <span className="cams-order__num">{i + 1}</span>
            <strong className="cams-order__name">{byId[id].name}</strong>
            <StatusBadge value={byId[id].health} />
            <span className="cams-order__arrows">
              <button className="btn btn--sm" disabled={i === 0} aria-label={`Move ${byId[id].name} up`}
                onClick={() => save(move(i, i - 1))}>↑</button>
              <button className="btn btn--sm" disabled={i === order.length - 1} aria-label={`Move ${byId[id].name} down`}
                onClick={() => save(move(i, i + 1))}>↓</button>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
