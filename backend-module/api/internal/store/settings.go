package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"time"

	"github.com/jackc/pgx/v5"
)

// migrations bring an existing database up to date with schema.sql. Each one is safe to
// run again, so they run at every start.
var migrations = []string{
	// Dashcam-style clips: one per camera that saw the incident (incidents.clip_key is the main one).
	`ALTER TABLE incident_cameras ADD COLUMN IF NOT EXISTS clip_key TEXT`,
	// Facility time zone (Settings page); NULL = each browser's own.
	`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS timezone TEXT`,
}

// Settings are facility-wide app settings.
type Settings struct {
	Timezone *string `json:"timezone"` // IANA zone, e.g. America/Toronto; null = each browser's own
}

// Settings returns the facility's settings.
func (s *Store) Settings(ctx context.Context) (Settings, error) {
	var out Settings
	err := s.tx(ctx, func(tx pgx.Tx, tid string) error {
		return tx.QueryRow(ctx, `SELECT timezone FROM tenants WHERE id::text = $1`, tid).Scan(&out.Timezone)
	})
	return out, err
}

// SetTimezone sets the facility time zone (nil = each browser's own) and logs the change.
func (s *Store) SetTimezone(ctx context.Context, tz *string, actor string) error {
	return s.tx(ctx, func(tx pgx.Tx, tid string) error {
		var before *string
		if err := tx.QueryRow(ctx, `SELECT timezone FROM tenants WHERE id::text = $1 FOR UPDATE`, tid).Scan(&before); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE tenants SET timezone = $1 WHERE id::text = $2`, tz, tid); err != nil {
			return err
		}
		return audit(ctx, tx, tid, actor, "settings.timezone", "settings", "", map[string]any{
			"message": "Time zone changed", "from": before, "to": tz,
		})
	})
}

// Migrate applies the migrations, retrying while the database is still starting.
func (s *Store) Migrate(ctx context.Context) error {
	var err error
	for attempt := 0; attempt < 30; attempt++ {
		if err = s.migrate(ctx); err == nil {
			return nil
		}
		log.Printf("database migration: %v (retrying)", err)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
	return err
}

func (s *Store) migrate(ctx context.Context) error {
	for _, m := range migrations {
		if _, err := s.pool.Exec(ctx, m); err != nil {
			return fmt.Errorf("%s: %w", m, err)
		}
	}
	return nil
}

// DetectionOverrides are detection settings changed in the frontend. They live in the
// fall rule's parsed_config.detection, which ml-service reloads every 15 s.
type DetectionOverrides struct {
	PersonConfidence *float64 `json:"person_confidence,omitempty"`
}

// Detection returns the saved overrides (empty if none).
func (s *Store) Detection(ctx context.Context) (DetectionOverrides, error) {
	var out DetectionOverrides
	err := s.tx(ctx, func(tx pgx.Tx, tid string) error {
		var raw []byte
		err := tx.QueryRow(ctx, `SELECT coalesce(parsed_config->'detection', '{}')::text FROM rules
			WHERE tenant_id = $1 AND is_enabled AND parsed_config->>'event_type' = 'fall'
			ORDER BY created_at LIMIT 1`, tid).Scan(&raw)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		return json.Unmarshal(raw, &out)
	})
	return out, err
}

// SetDetection saves the overrides (a nil field goes back to config.yaml's value) and
// records who changed what. Creates the tenant's fall rule if it has none.
func (s *Store) SetDetection(ctx context.Context, d DetectionOverrides, actor string) error {
	return s.tx(ctx, func(tx pgx.Tx, tid string) error {
		var ruleID string
		var before []byte
		err := tx.QueryRow(ctx, `SELECT id::text, coalesce(parsed_config->'detection', '{}')::text FROM rules
			WHERE tenant_id = $1 AND is_enabled AND parsed_config->>'event_type' = 'fall'
			ORDER BY created_at LIMIT 1 FOR UPDATE`, tid).Scan(&ruleID, &before)
		if errors.Is(err, pgx.ErrNoRows) {
			err = tx.QueryRow(ctx, `INSERT INTO rules (tenant_id, name, prompt_text, parsed_config)
				VALUES ($1, 'Fall detection', 'Alert me when a person falls', '{"event_type": "fall"}')
				RETURNING id::text`, tid).Scan(&ruleID)
			before = []byte("{}")
		}
		if err != nil {
			return err
		}
		after, err := json.Marshal(d)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE rules SET parsed_config = parsed_config || jsonb_build_object('detection', $1::jsonb),
			updated_at = now() WHERE id::text = $2`, string(after), ruleID); err != nil {
			return err
		}
		return audit(ctx, tx, tid, actor, "settings.detection", "settings", ruleID, map[string]any{
			"message": "Detection settings changed", "from": json.RawMessage(before), "to": json.RawMessage(after),
		})
	})
}
