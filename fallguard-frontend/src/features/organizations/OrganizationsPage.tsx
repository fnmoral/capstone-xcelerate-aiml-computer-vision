import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../../components/ui/PageHeader';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { accounts, type OrgSummary } from '../../services/api/accounts';
import { usePolling } from '../../services/api/usePolling';
import { formatDate } from '../../lib/format';
import { useAuth } from '../auth/AuthContext';
import './organizations.css';

/** Super admins: every organization; create, open (switch to), delete and restore. */
export default function OrganizationsPage() {
  const { me, refresh } = useAuth();
  const navigate = useNavigate();
  const { data, error: loadError, reload } = usePolling(() => accounts.allOrgs(), 15000);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; name: string } | null>(null);

  if (!me?.user.super_admin) {
    return <><PageHeader title="Manage organizations" /><p className="notice">Only a FallGuard super admin can manage organizations.</p></>;
  }

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (done) setNotice(done);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const open = (o: { id: string }) => run(async () => {
    await accounts.switchOrg(o.id);
    await refresh();
    navigate('/', { replace: true });
    window.location.reload(); // every page reloads its data for the other organization
  });

  const create = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    void run(async () => {
      const { id } = await accounts.createOrg(n);
      setCreated({ id, name: n });
      setName('');
    });
  };

  const remove = (o: OrgSummary) => {
    const typed = prompt(`Delete "${o.name}"?\n\nNobody can open it from now on. You can restore it for 30 days; then it and all its data (members, cameras, fall events, reports) are erased for good.\n\nType the organization's name to confirm:`);
    if (typed === null) return;
    if (typed.trim() !== o.name) {
      setError("The name didn't match: nothing was deleted.");
      return;
    }
    void run(() => accounts.deleteOrg(o.id), `"${o.name}" deleted. Restore it here within 30 days if needed.`);
  };

  const orgs = data?.orgs ?? [];
  const current = data?.current ?? me.org.id;
  const active = orgs.filter((o) => o.status === 'active');
  const deleted = orgs.filter((o) => o.status === 'deleted');

  return (
    <>
      <PageHeader title="Manage organizations"
        description="Every organization on this FallGuard server. As a super admin you are an admin of each: open one to manage it like its own admins do." />
      {(error || loadError) && <p className="notice notice--error">{error || loadError}</p>}
      {notice && <p className="notice" role="status">{notice}</p>}

      <form className="card orgs-create" onSubmit={create}>
        <h2 className="section-title">New organization</h2>
        <div className="orgs-create__row">
          <label className="field">Name<input value={name} onChange={(e) => setName(e.target.value)} maxLength={100}
            placeholder="Maple Grove Care Home" required /></label>
          <button className="btn btn--primary" disabled={busy || !name.trim()}>Create</button>
        </div>
        {created ? (
          <p className="notice orgs-create__done">
            "{created.name}" created. Open it, then invite its first admin in Members &amp; roles.{' '}
            <button type="button" className="btn btn--sm" disabled={busy} onClick={() => void open(created)}>Open it</button>
          </p>
        ) : (
          <p className="muted orgs-create__hint">It starts empty. Open it to invite its admin and set it up. Cameras need a gateway connected to it.</p>
        )}
      </form>

      <section className="card orgs-list">
        <h2 className="section-title">Organizations ({active.length})</h2>
        <div className="table-wrap">
          <table className="table table--stack">
            <thead><tr><th>Organization</th><th className="num">Members</th><th className="num">Cameras</th><th>Created</th><th /></tr></thead>
            <tbody>
              {active.map((o) => (
                <tr key={o.id}>
                  <td>
                    <strong>{o.name}</strong>
                    {o.id === current && <span className="badge orgs-badge">You're here</span>}
                    {o.home && <span className="badge orgs-badge" title="Has the gateway and fall detector; can't be deleted">Home</span>}
                  </td>
                  <td className="num">{o.members}</td>
                  <td className="num">{o.cameras}</td>
                  <td className="muted">{formatDate(o.created_at)}</td>
                  <td className="num orgs-actions">
                    {o.id !== current && <button className="btn btn--sm btn--primary" disabled={busy} onClick={() => void open(o)}>Open</button>}
                    {!o.home && o.id !== current && (
                      <button className="btn btn--sm btn--danger" disabled={busy} onClick={() => remove(o)}>Delete</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted orgs-note">To delete the organization you're in, open another one first.</p>
      </section>

      {deleted.length > 0 && (
        <section className="card orgs-list">
          <h2 className="section-title">Deleted ({deleted.length})</h2>
          <div className="table-wrap">
            <table className="table table--stack">
              <thead><tr><th>Organization</th><th>Deleted</th><th>Erased for good</th><th /></tr></thead>
              <tbody>
                {deleted.map((o) => (
                  <tr key={o.id}>
                    <td><strong>{o.name}</strong> <StatusBadge value="paused" label="Deleted" /></td>
                    <td className="muted">{formatDate(o.deleted_at)}</td>
                    <td className="muted">{formatDate(o.erase_at)}</td>
                    <td className="num">
                      <button className="btn btn--sm" disabled={busy}
                        onClick={() => void run(() => accounts.restoreOrg(o.id), `"${o.name}" restored.`)}>Restore</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
