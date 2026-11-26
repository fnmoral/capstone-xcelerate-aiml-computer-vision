import { accounts } from '../../services/api/accounts';
import { usePolling } from '../../services/api/usePolling';
import { formatTime } from '../../lib/format';

const ACTION: Record<string, string> = {
  'org.created': 'Created',
  'org.deleted': 'Deleted',
  'org.restored': 'Restored',
  'org.erased': 'Erased',
  'incident.deleted_forever': 'Fall event deleted',
};

/** Super admins: who created, deleted, restored or erased organizations, and who deleted fall
 *  events permanently. Kept even after an organization is erased. */
export function PlatformActivity() {
  const { data, error } = usePolling(() => accounts.platformActivity(), 30000);
  const list = data?.entries ?? [];
  return (
    <section className="card orgs-list">
      <h2 className="section-title">Super admin activity</h2>
      <p className="muted orgs-note" style={{ marginTop: -4, marginBottom: 12 }}>
        Organizations created, deleted, restored or erased, and fall events deleted permanently. Kept even after an
        organization is erased.
      </p>
      {error && <p className="notice notice--error">{error}</p>}
      {list.length === 0 ? <p className="muted">Nothing yet.</p> : (
        <div className="table-wrap">
          <table className="table table--stack">
            <thead><tr><th>When</th><th>Who</th><th>What</th><th>Organization</th><th>Details</th></tr></thead>
            <tbody>
              {list.map((e, i) => (
                <tr key={i}>
                  <td className="muted">{formatTime(e.at)}</td>
                  <td>{e.actor}</td>
                  <td><strong>{ACTION[e.action] ?? e.action}</strong></td>
                  <td>{e.org_name ?? '—'}</td>
                  <td className="muted">{e.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
