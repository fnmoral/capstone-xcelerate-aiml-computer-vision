package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// Demo access links: view-only access to an organization for a limited time, without an
// account. Each link has its own hidden "visitor" user (users.guest_link_id), a viewer
// member of the organization; everyone who opens the link shares it (one session per
// browser). The link's expiry and revocation are checked on every request
// (SessionByToken), so access ends on time.

func init() {
	migrations = append(migrations,
		`CREATE TABLE IF NOT EXISTS guest_links (
			id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
			label         TEXT NOT NULL,
			token_hash    TEXT NOT NULL UNIQUE,
			created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
			expires_at    TIMESTAMPTZ NOT NULL,
			revoked_at    TIMESTAMPTZ,
			visits        INT NOT NULL DEFAULT 0,
			last_visit_at TIMESTAMPTZ,
			created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_guest_links_tenant ON guest_links (tenant_id, created_at DESC)`,
		`ALTER TABLE users ADD COLUMN IF NOT EXISTS guest_link_id UUID`,
		`CREATE INDEX IF NOT EXISTS idx_users_guest ON users (guest_link_id) WHERE guest_link_id IS NOT NULL`,
	)
}

// GuestLink is a demo access link as the Members page shows it.
type GuestLink struct {
	ID          string     `json:"id"`
	Label       string     `json:"label"`
	ExpiresAt   time.Time  `json:"expires_at"`
	RevokedAt   *time.Time `json:"revoked_at"`
	Visits      int        `json:"visits"`
	LastVisitAt *time.Time `json:"last_visit_at"`
	CreatedBy   *string    `json:"created_by"`
	CreatedAt   time.Time  `json:"created_at"`
	Status      string     `json:"status"` // active | expired | revoked
}

const guestLinkColumns = `g.id::text, g.label, g.expires_at, g.revoked_at, g.visits, g.last_visit_at,
	nullif(trim(coalesce(cu.first_name, '') || ' ' || coalesce(cu.last_name, '')), ''), g.created_at,
	CASE WHEN g.revoked_at IS NOT NULL THEN 'revoked' WHEN g.expires_at <= now() THEN 'expired' ELSE 'active' END`

func scanGuestLink(r pgx.Row, g *GuestLink) error {
	return r.Scan(&g.ID, &g.Label, &g.ExpiresAt, &g.RevokedAt, &g.Visits, &g.LastVisitAt, &g.CreatedBy, &g.CreatedAt, &g.Status)
}

// GuestLinks lists the organization's demo access links, newest first (ended ones for 30 days).
func (s *Store) GuestLinks(ctx context.Context) ([]GuestLink, error) {
	out := []GuestLink{}
	err := s.tx(ctx, func(tx pgx.Tx, tid string) error {
		rows, err := tx.Query(ctx, `SELECT `+guestLinkColumns+` FROM guest_links g LEFT JOIN users cu ON cu.id = g.created_by
			WHERE g.tenant_id = $1 AND coalesce(g.revoked_at, g.expires_at) > now() - interval '30 days'
			ORDER BY g.created_at DESC LIMIT 200`, tid)
		if err != nil {
			return err
		}
		out, err = pgx.CollectRows(rows, func(r pgx.CollectableRow) (GuestLink, error) {
			var g GuestLink
			return g, scanGuestLink(r, &g)
		})
		return err
	})
	return out, err
}

// CreateGuestLink makes a demo access link and its visitor user (a viewer of the organization).
func (s *Store) CreateGuestLink(ctx context.Context, label, tokenHash string, expiresAt time.Time, actor string) (*GuestLink, error) {
	var out GuestLink
	err := s.tx(ctx, func(tx pgx.Tx, tid string) error {
		var id string
		if err := tx.QueryRow(ctx, `INSERT INTO guest_links (tenant_id, label, token_hash, created_by, expires_at)
			VALUES ($1, $2, $3, $4, $5) RETURNING id::text`, tid, label, tokenHash, actorID(ctx), expiresAt).Scan(&id); err != nil {
			return err
		}
		var userID string
		// The address is never used for mail or sign-in (.invalid is a reserved domain).
		if err := tx.QueryRow(ctx, `INSERT INTO users (email, first_name, last_name, full_name, guest_link_id, email_verified_at)
			VALUES ($1::citext, 'Demo visitor', $2, 'Demo visitor ' || $2, $3, now()) RETURNING id::text`,
			"demo-"+id+"@visitor.fallguard.invalid", label, id).Scan(&userID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO memberships (tenant_id, user_id, role, invited_by) VALUES ($1, $2, 'viewer', $3)`,
			tid, userID, actorID(ctx)); err != nil {
			return err
		}
		if err := scanGuestLink(tx.QueryRow(ctx, `SELECT `+guestLinkColumns+` FROM guest_links g
			LEFT JOIN users cu ON cu.id = g.created_by WHERE g.id = $1`, id), &out); err != nil {
			return err
		}
		return audit(ctx, tx, tid, actor, "member.demo_link_created", "guest_link", id, map[string]any{
			"message": "Demo access link created: " + label + " (until " + expiresAt.UTC().Format(time.RFC3339) + ")",
			"label":   label, "expires_at": expiresAt})
	})
	return &out, err
}

// RevokeGuestLink ends a demo access link now and signs out everyone using it.
func (s *Store) RevokeGuestLink(ctx context.Context, id, actor string) error {
	return s.tx(ctx, func(tx pgx.Tx, tid string) error {
		var label string
		err := tx.QueryRow(ctx, `UPDATE guest_links SET revoked_at = now() WHERE tenant_id = $1 AND id::text = $2
			AND revoked_at IS NULL RETURNING label`, tid, id).Scan(&label)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE guest_link_id::text = $1)`, id); err != nil {
			return err
		}
		return audit(ctx, tx, tid, actor, "member.demo_link_revoked", "guest_link", id,
			map[string]any{"message": "Demo access link ended: " + label, "label": label})
	})
}

// GuestEntry is what opening a demo link needs.
type GuestEntry struct {
	OrgName   string    `json:"org_name"`
	Label     string    `json:"label"`
	ExpiresAt time.Time `json:"expires_at"`
	linkID    string
	UserID    string `json:"-"`
	TenantID  string `json:"-"`
}

// GuestLinkByToken returns an active (not expired, not revoked) demo link, or ErrTokenInvalid.
func (s *Store) GuestLinkByToken(ctx context.Context, tokenHash string) (*GuestEntry, error) {
	var e GuestEntry
	err := s.pool.QueryRow(ctx, `SELECT g.id::text, t.name, g.label, g.expires_at, u.id::text, g.tenant_id::text
		FROM guest_links g JOIN tenants t ON t.id = g.tenant_id AND t.status = 'active'
		JOIN users u ON u.guest_link_id = g.id
		WHERE g.token_hash = $1 AND g.revoked_at IS NULL AND g.expires_at > now()`, tokenHash).
		Scan(&e.linkID, &e.OrgName, &e.Label, &e.ExpiresAt, &e.UserID, &e.TenantID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrTokenInvalid
	}
	return &e, err
}

// GuestVisited counts a visit through a demo link.
func (s *Store) GuestVisited(ctx context.Context, e *GuestEntry) error {
	_, err := s.pool.Exec(ctx, `UPDATE guest_links SET visits = visits + 1, last_visit_at = now() WHERE id = $1`, e.linkID)
	return err
}

// PurgeGuests removes the visitor users of demo links that ended more than 30 days ago
// (their memberships and sessions go with them; the activity log keeps their name).
func (s *Store) PurgeGuests(ctx context.Context) (int64, error) {
	tag, err := s.pool.Exec(ctx, `DELETE FROM users u USING guest_links g
		WHERE u.guest_link_id = g.id AND coalesce(g.revoked_at, g.expires_at) < now() - interval '30 days'`)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
