package store

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"
)

// The organization's default overlays on incident videos (box, status, person number,
// confidence, skeleton...): what everyone sees until they change them on the incident page.
// NULL = the app's built-in default.

func init() {
	migrations = append(migrations,
		`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS incident_overlay JSONB`,
	)
}

// SetIncidentOverlay saves the organization's default incident video overlays (name -> on/off)
// and logs the change.
func (s *Store) SetIncidentOverlay(ctx context.Context, overlay map[string]bool, actor string) error {
	raw, err := json.Marshal(overlay)
	if err != nil {
		return err
	}
	return s.tx(ctx, func(tx pgx.Tx, tid string) error {
		var before []byte
		if err := tx.QueryRow(ctx, `SELECT incident_overlay FROM tenants WHERE id::text = $1 FOR UPDATE`, tid).Scan(&before); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE tenants SET incident_overlay = $1 WHERE id::text = $2`, raw, tid); err != nil {
			return err
		}
		return audit(ctx, tx, tid, actor, "settings.incident_overlay", "settings", "", map[string]any{
			"message": "Default incident video overlays changed", "from": json.RawMessage(nullIfEmpty(before)), "to": overlay,
		})
	})
}

func nullIfEmpty(b []byte) []byte {
	if len(b) == 0 {
		return []byte("null")
	}
	return b
}
