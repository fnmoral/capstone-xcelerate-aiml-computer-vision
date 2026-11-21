package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// AccountEmail is one account email the API tried to send (invitation, email verification,
// password reset), for Settings > Emails sent. The body isn't kept: it holds sign-in links.
type AccountEmail struct {
	ID        string    `json:"id"`
	Kind      string    `json:"kind"` // invitation | verification | password_reset
	Recipient string    `json:"recipient"`
	Subject   string    `json:"subject"`
	FromEmail string    `json:"from_email"`
	Via       string    `json:"via"`    // server_smtp | org_smtp | log
	Status    string    `json:"status"` // sent | logged (not sent: no email server) | failed
	Error     *string   `json:"error"`
	CreatedAt time.Time `json:"created_at"`
}

// accountEmailDays is how long account emails stay in the list.
const accountEmailDays = 90

// LogAccountEmail records an account email. tenantID may be "" (e.g. a password reset,
// which belongs to the person, not an organization).
func (s *Store) LogAccountEmail(ctx context.Context, tenantID string, e AccountEmail) error {
	var tid *string
	if tenantID != "" {
		tid = &tenantID
	}
	_, err := s.pool.Exec(ctx, `INSERT INTO account_emails (tenant_id, kind, recipient, subject, from_email, via, status, error)
		VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8)`, tid, e.Kind, e.Recipient, e.Subject, e.FromEmail, e.Via, e.Status, e.Error)
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, `DELETE FROM account_emails WHERE created_at < now() - make_interval(days => $1)`, accountEmailDays)
	return err
}

// AccountEmails lists the organization's account emails, newest first: the ones sent for it
// (invitations, sign-up verification) and its members' own ones (password resets).
func (s *Store) AccountEmails(ctx context.Context, limit int) ([]AccountEmail, error) {
	out := []AccountEmail{}
	err := s.tx(ctx, func(tx pgx.Tx, tid string) error {
		rows, err := tx.Query(ctx, `SELECT e.id::text, e.kind, e.recipient, e.subject, e.from_email, e.via, e.status, e.error, e.created_at
			FROM account_emails e
			WHERE e.tenant_id = $1
			   OR (e.tenant_id IS NULL AND lower(e.recipient) IN (
			         SELECT lower(u.email::text) FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = $1))
			ORDER BY e.created_at DESC LIMIT $2`, tid, limit)
		if err != nil {
			return err
		}
		out, err = pgx.CollectRows(rows, func(r pgx.CollectableRow) (AccountEmail, error) {
			var e AccountEmail
			err := r.Scan(&e.ID, &e.Kind, &e.Recipient, &e.Subject, &e.FromEmail, &e.Via, &e.Status, &e.Error, &e.CreatedAt)
			return e, err
		})
		return err
	})
	return out, err
}
