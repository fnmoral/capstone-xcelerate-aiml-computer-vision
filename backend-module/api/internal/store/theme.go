package store

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// The organization's default theme (light / dark / system): what people see until they pick
// their own theme in Settings → Appearance. NULL = light.

func init() {
	migrations = append(migrations,
		`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS default_theme TEXT`,
		`ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_default_theme_check`,
		`ALTER TABLE tenants ADD CONSTRAINT tenants_default_theme_check CHECK (default_theme IN ('light','dark','system'))`,
	)
}

// SetDefaultTheme sets the organization's default theme and logs the change.
func (s *Store) SetDefaultTheme(ctx context.Context, theme, actor string) error {
	return s.tx(ctx, func(tx pgx.Tx, tid string) error {
		var before *string
		if err := tx.QueryRow(ctx, `SELECT default_theme FROM tenants WHERE id::text = $1 FOR UPDATE`, tid).Scan(&before); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE tenants SET default_theme = $1 WHERE id::text = $2`, theme, tid); err != nil {
			return err
		}
		return audit(ctx, tx, tid, actor, "settings.theme", "settings", "", map[string]any{
			"message": "Default theme changed to " + theme, "from": before, "to": theme,
		})
	})
}
