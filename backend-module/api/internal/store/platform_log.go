package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// Platform log: what super admins did to organizations and fall events (created, deleted,
// restored, erased; fall events deleted permanently). Not tied to an organization, so the
// record stays when an organization and its own activity log are erased.

func init() {
	migrations = append(migrations,
		`CREATE TABLE IF NOT EXISTS platform_log (
			id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			at       TIMESTAMPTZ NOT NULL DEFAULT now(),
			actor    TEXT NOT NULL,
			action   TEXT NOT NULL,
			org_id   UUID,
			org_name TEXT,
			message  TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS platform_log_at ON platform_log (at DESC)`,
	)
}

// PlatformEntry is one line of the platform log.
type PlatformEntry struct {
	At      time.Time `json:"at"`
	Actor   string    `json:"actor"`
	Action  string    `json:"action"`
	OrgID   *string   `json:"org_id"`
	OrgName *string   `json:"org_name"`
	Message string    `json:"message"`
}

// platformLog records one line, in the caller's transaction. orgID "" = none.
func platformLog(ctx context.Context, tx pgx.Tx, actor, action, orgID, message string) error {
	_, err := tx.Exec(ctx, `INSERT INTO platform_log (actor, action, org_id, org_name, message)
		VALUES ($1, $2, nullif($3, '')::uuid, (SELECT name FROM tenants WHERE id::text = $3), $4)`,
		actor, action, orgID, message)
	return err
}

// PlatformLog lists the newest lines (super admins).
func (s *Store) PlatformLog(ctx context.Context, limit int) ([]PlatformEntry, error) {
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	rows, err := s.pool.Query(ctx, `SELECT at, actor, action, org_id::text, org_name, message FROM platform_log
		ORDER BY at DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (PlatformEntry, error) {
		var e PlatformEntry
		err := r.Scan(&e.At, &e.Actor, &e.Action, &e.OrgID, &e.OrgName, &e.Message)
		return e, err
	})
}
