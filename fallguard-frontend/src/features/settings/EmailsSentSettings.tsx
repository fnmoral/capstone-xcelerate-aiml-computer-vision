import { api, type AccountEmail } from '../../services/api/fallguard';
import { usePolling } from '../../services/api/usePolling';
import { formatTime } from '../../lib/format';

const KIND: Record<string, string> = {
  invitation: 'Invitation',
  verification: 'Email check',
  password_reset: 'Password reset',
};

function Status({ e }: { e: AccountEmail }) {
  if (e.status === 'sent') return <span className="badge badge--good">Sent</span>;
  if (e.status === 'failed') return <span className="badge badge--critical" title={e.error ?? ''}>Failed</span>;
  return <span className="badge badge--warning" title="No email server is set up: the message was only written to the server log">Not sent</span>;
}

/** Account emails (invitations, email checks, password resets) and whether they went out. */
export function EmailsSentSettings() {
  const { data, error } = usePolling(() => api.accountEmails(), 15000);
  const emails = data?.emails ?? [];
  const from = data?.server_from || emails.find((e) => e.from_email)?.from_email;

  return (
    <section className="card" style={{ padding: 20 }}>
      <h2 className="section-title">Emails sent</h2>
      <p className="muted" style={{ margin: '0 0 12px' }}>
        Invitations, email checks and password resets{from ? <> from <b>{from}</b></> : null}, last {data?.kept_days ?? 90} days.
        “Sent” means the email server accepted it. If it didn't arrive, ask the person to check their spam or junk folder.
        Fall alerts are listed on the Notifications page.
      </p>
      {error && <p className="notice notice--error">{error}</p>}
      {data && emails.length === 0 && <p className="muted">No emails yet.</p>}
      {emails.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr><th>When</th><th>To</th><th>What</th><th>Status</th></tr>
            </thead>
            <tbody>
              {emails.map((e) => (
                <tr key={e.id}>
                  <td className="muted" style={{ whiteSpace: 'nowrap' }}>{formatTime(e.created_at)}</td>
                  <td style={{ wordBreak: 'break-all' }}>{e.recipient}</td>
                  <td title={e.subject}>{KIND[e.kind] ?? e.kind}</td>
                  <td>
                    <Status e={e} />
                    {e.status === 'failed' && e.error && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{e.error.slice(0, 120)}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
