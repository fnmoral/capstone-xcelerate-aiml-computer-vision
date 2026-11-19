package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// ShareLink is a view-only link to one incident's video and basic facts, for someone
// without an account (e.g. a regulator). Only the token's hash is stored: the link itself
// is shown once, when it is created. It stops working when it expires or is revoked.
type ShareLink struct {
	ID           string     `json:"id"`
	IncidentID   string     `json:"incident_id"`
	Recipient    string     `json:"recipient"`
	CreatedBy    *string    `json:"created_by"`
	CreatedAt    time.Time  `json:"created_at"`
	ExpiresAt    time.Time  `json:"expires_at"`
	RevokedAt    *time.Time `json:"revoked_at"`
	Views        int        `json:"views"`
	LastViewedAt *time.Time `json:"last_viewed_at"`
}

// SharedLink is what a valid share token opens.
type SharedLink struct {
	ID         string
	TenantID   string
	IncidentID string
	ExpiresAt  time.Time
}

const shareLinkColumns = `l.id::text, l.incident_id::text, l.recipient,
	nullif(trim(coalesce(u.first_name, '') || ' ' || coalesce(u.last_name, '')), ''),
	l.created_at, l.expires_at, l.revoked_at, l.views, l.last_viewed_at`

func scanShareLink(r pgx.Row, l *ShareLink) error {
	return r.Scan(&l.ID, &l.IncidentID, &l.Recipient, &l.CreatedBy, &l.CreatedAt, &l.ExpiresAt, &l.RevokedAt, &l.Views, &l.LastViewedAt)
}

// CreateShareLink saves a share link for an incident, valid for days; tokenHash is
// auth.HashToken(token).
func (s *Store) CreateShareLink(ctx context.Context, incidentID, recipient, tokenHash string, days int, actor string) (*ShareLink, error) {
	var out ShareLink
	err := s.tx(ctx, func(tx pgx.Tx, tid string) error {
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM incidents WHERE tenant_id = $1 AND id::text = $2)`,
			tid, incidentID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return ErrNotFound
		}
		err := scanShareLink(tx.QueryRow(ctx, `WITH l AS (
			  INSERT INTO shared_links (tenant_id, incident_id, recipient, token_hash, created_by, expires_at)
			  VALUES ($1, $2::uuid, $3, $4, $5, now() + make_interval(days => $6)) RETURNING *)
			SELECT `+shareLinkColumns+` FROM l LEFT JOIN users u ON u.id = l.created_by`,
			tid, incidentID, recipient, tokenHash, actorID(ctx), days), &out)
		if err != nil {
			return err
		}
		return audit(ctx, tx, tid, actor, "incident.shared", "incident", incidentID, map[string]any{
			"message":     "Video shared with " + recipient + " (view-only link, expires " + out.ExpiresAt.Format("2006-01-02") + ")",
			"incident_id": incidentID, "share_link_id": out.ID})
	})
	return &out, err
}

// ShareLinks lists an incident's share links, newest first (revoked and expired included).
func (s *Store) ShareLinks(ctx context.Context, incidentID string) ([]ShareLink, error) {
	out := []ShareLink{}
	err := s.tx(ctx, func(tx pgx.Tx, tid string) error {
		rows, err := tx.Query(ctx, `SELECT `+shareLinkColumns+` FROM shared_links l LEFT JOIN users u ON u.id = l.created_by
			WHERE l.tenant_id = $1 AND l.incident_id::text = $2 ORDER BY l.created_at DESC`, tid, incidentID)
		if err != nil {
			return err
		}
		out, err = pgx.CollectRows(rows, func(r pgx.CollectableRow) (ShareLink, error) {
			var l ShareLink
			return l, scanShareLink(r, &l)
		})
		return err
	})
	return out, err
}

// RevokeShareLink stops a share link working.
func (s *Store) RevokeShareLink(ctx context.Context, id, actor string) error {
	return s.tx(ctx, func(tx pgx.Tx, tid string) error {
		var incidentID, recipient string
		err := tx.QueryRow(ctx, `UPDATE shared_links SET revoked_at = now(), revoked_by = $3
			WHERE tenant_id = $1 AND id::text = $2 AND revoked_at IS NULL RETURNING incident_id::text, recipient`,
			tid, id, actorID(ctx)).Scan(&incidentID, &recipient)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		return audit(ctx, tx, tid, actor, "incident.share_revoked", "incident", incidentID, map[string]any{
			"message": "Video link for " + recipient + " revoked", "incident_id": incidentID, "share_link_id": id})
	})
}

// SharedLinkByToken returns what a share token opens, if the link is still valid. It has no
// session (the viewer has no account), so it reads across organizations like invitations do.
func (s *Store) SharedLinkByToken(ctx context.Context, tokenHash string) (*SharedLink, error) {
	var l SharedLink
	err := s.pool.QueryRow(ctx, `SELECT id::text, tenant_id::text, incident_id::text, expires_at FROM shared_links
		WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`, tokenHash).
		Scan(&l.ID, &l.TenantID, &l.IncidentID, &l.ExpiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrTokenInvalid
	}
	return &l, err
}

// ShareLinkViewed counts a view of the shared page and logs it on the incident.
// ctx must carry the link's tenant (WithTenant).
func (s *Store) ShareLinkViewed(ctx context.Context, l *SharedLink, ip string) error {
	return s.tx(ctx, func(tx pgx.Tx, tid string) error {
		var recipient string
		if err := tx.QueryRow(ctx, `UPDATE shared_links SET views = views + 1, last_viewed_at = now()
			WHERE tenant_id = $1 AND id::text = $2 RETURNING recipient`, tid, l.ID).Scan(&recipient); err != nil {
			return err
		}
		return audit(ctx, tx, tid, "Shared link", "incident.share_viewed", "incident", l.IncidentID, map[string]any{
			"message": "Shared video opened (link for " + recipient + ")", "incident_id": l.IncidentID, "share_link_id": l.ID, "ip": ip})
	})
}
