package store

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Camera is a row of the cameras table (DB1) plus its zone name.
//
// Status is kept up to date by the API's camera monitor: online, disabled (paused),
// error (on the gateway but no video arriving) or offline (not on the gateway).
type Camera struct {
	ID           string     `json:"id"`
	Name         string     `json:"name"`
	Location     *string    `json:"location"`
	Zone         *string    `json:"zone"`
	Status       string     `json:"db_status"`
	StatusSince  *time.Time `json:"status_since"`  // when Status last changed (metadata.status_since)
	AlertOffline bool       `json:"alert_offline"` // notify when it stops working (metadata.alert_offline, default on)
	CreatedAt    time.Time  `json:"created_at"`
}

// ErrNameTaken is returned when another camera already has the name.
var ErrNameTaken = errors.New("a camera with this name already exists")

// SafeURL removes any user:password from an RTSP URL. Credentials stay in gateway-back only.
func SafeURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	u.User = nil
	return u.String()
}

// Cameras lists the tenant's cameras.
func (s *Store) Cameras(ctx context.Context) ([]Camera, error) {
	var out []Camera
	err := s.tx(ctx, func(tx pgx.Tx, tid string) error {
		rows, err := tx.Query(ctx, `
			SELECT c.id::text, c.name, c.location, z.name, c.status,
			       (c.metadata->>'status_since')::timestamptz,
			       coalesce((c.metadata->>'alert_offline')::boolean, true), c.created_at
			FROM cameras c LEFT JOIN zones z ON z.id = c.zone_id
			WHERE c.tenant_id = $1 ORDER BY c.created_at`, tid)
		if err != nil {
			return err
		}
		out, err = pgx.CollectRows(rows, func(r pgx.CollectableRow) (Camera, error) {
			var c Camera
			err := r.Scan(&c.ID, &c.Name, &c.Location, &c.Zone, &c.Status, &c.StatusSince, &c.AlertOffline, &c.CreatedAt)
			return c, err
		})
		return err
	})
	return out, err
}

// UpsertCamera registers a camera under the ID gateway-back gave it. If the name is
// already used by another camera, a numbered suffix is added.
func (s *Store) UpsertCamera(ctx context.Context, id, name, rtspURL, status string, location, zone *string) error {
	return s.tx(ctx, func(tx pgx.Tx, tid string) error {
		zoneID, err := zoneID(ctx, tx, tid, zone)
		if err != nil {
			return err
		}
		for i := 1; i <= 20; i++ {
			candidate := name
			if i > 1 {
				candidate = fmt.Sprintf("%s (%d)", name, i)
			}
			_, err = tx.Exec(ctx, `SAVEPOINT cam`)
			if err != nil {
				return err
			}
			_, err = tx.Exec(ctx, `
				INSERT INTO cameras (id, tenant_id, name, rtsp_url_enc, status, location, zone_id, metadata)
				VALUES ($1, $2, $3, $4, $5, $6, $7, jsonb_build_object('status_since', now()))
				ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status`,
				id, tid, candidate, []byte(SafeURL(rtspURL)), status, location, zoneID)
			if isUnique(err, "cameras_tenant_id_name_key") {
				if _, err := tx.Exec(ctx, `ROLLBACK TO SAVEPOINT cam`); err != nil {
					return err
				}
				continue
			}
			return err
		}
		return ErrNameTaken
	})
}

// UpdateCamera changes name, location and/or zone (nil = keep; "" = clear location/zone).
func (s *Store) UpdateCamera(ctx context.Context, id string, name, location, zone *string) error {
	return s.tx(ctx, func(tx pgx.Tx, tid string) error {
		if name != nil {
			tag, err := tx.Exec(ctx, `UPDATE cameras SET name = $1 WHERE id = $2 AND tenant_id = $3`, *name, id, tid)
			if isUnique(err, "cameras_tenant_id_name_key") {
				return ErrNameTaken
			}
			if err != nil {
				return err
			}
			if tag.RowsAffected() == 0 {
				return ErrNotFound
			}
		}
		if location != nil {
			var loc *string
			if *location != "" {
				loc = location
			}
			if _, err := tx.Exec(ctx, `UPDATE cameras SET location = $1 WHERE id = $2 AND tenant_id = $3`, loc, id, tid); err != nil {
				return err
			}
		}
		if zone != nil {
			zid, err := zoneID(ctx, tx, tid, zone)
			if err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `UPDATE cameras SET zone_id = $1 WHERE id = $2 AND tenant_id = $3`, zid, id, tid); err != nil {
				return err
			}
			// Zones nobody uses any more are removed, so the list stays tidy.
			if _, err := tx.Exec(ctx, `DELETE FROM zones z WHERE z.tenant_id = $1
				AND NOT EXISTS (SELECT 1 FROM cameras c WHERE c.zone_id = z.id)`, tid); err != nil {
				return err
			}
		}
		return nil
	})
}

// SetCameraStatus stores the status ('online', 'disabled' while paused, 'error', 'offline')
// and when it changed. It returns the previous status; changed is false if the camera
// already had it (or doesn't exist), so callers log only real changes.
func (s *Store) SetCameraStatus(ctx context.Context, id, status string) (from string, changed bool, err error) {
	err = s.tx(ctx, func(tx pgx.Tx, tid string) error {
		err := tx.QueryRow(ctx, `
			UPDATE cameras c
			SET status = $1, metadata = c.metadata || jsonb_build_object('status_since', now())
			FROM (SELECT id, status FROM cameras WHERE id::text = $2 AND tenant_id = $3 FOR UPDATE) old
			WHERE c.id = old.id AND old.status <> $1
			RETURNING old.status`, status, id, tid).Scan(&from)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		changed = err == nil
		return err
	})
	return from, changed, err
}

// SetCameraAlert turns "notify me when this camera stops working" on or off.
func (s *Store) SetCameraAlert(ctx context.Context, id string, on bool) error {
	return s.tx(ctx, func(tx pgx.Tx, tid string) error {
		tag, err := tx.Exec(ctx, `UPDATE cameras SET metadata = metadata || jsonb_build_object('alert_offline', $1::boolean)
			WHERE id::text = $2 AND tenant_id = $3`, on, id, tid)
		if err == nil && tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		return err
	})
}

// DeleteCamera removes the camera row and returns its name ("" if it didn't exist).
// Its incidents keep their (soft) camera_id.
func (s *Store) DeleteCamera(ctx context.Context, id string) (string, error) {
	var name string
	err := s.tx(ctx, func(tx pgx.Tx, tid string) error {
		err := tx.QueryRow(ctx, `DELETE FROM cameras WHERE id::text = $1 AND tenant_id = $2 RETURNING name`, id, tid).Scan(&name)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return err
	})
	return name, err
}

// Zone is a zone with its cameras.
type Zone struct {
	Name    string   `json:"name"`
	Cameras []string `json:"camera_ids"`
}

// Zones lists the tenant's zones.
func (s *Store) Zones(ctx context.Context) ([]Zone, error) {
	var out []Zone
	err := s.tx(ctx, func(tx pgx.Tx, tid string) error {
		rows, err := tx.Query(ctx, `
			SELECT z.name, coalesce(array_agg(c.id::text ORDER BY c.name) FILTER (WHERE c.id IS NOT NULL), '{}')
			FROM zones z LEFT JOIN cameras c ON c.zone_id = z.id
			WHERE z.tenant_id = $1 GROUP BY z.name ORDER BY z.name`, tid)
		if err != nil {
			return err
		}
		out, err = pgx.CollectRows(rows, func(r pgx.CollectableRow) (Zone, error) {
			var z Zone
			err := r.Scan(&z.Name, &z.Cameras)
			return z, err
		})
		return err
	})
	return out, err
}

// zoneID finds or creates the zone named *zone; nil or "" means no zone.
func zoneID(ctx context.Context, tx pgx.Tx, tid string, zone *string) (*string, error) {
	if zone == nil || *zone == "" {
		return nil, nil
	}
	var id string
	err := tx.QueryRow(ctx, `
		INSERT INTO zones (tenant_id, name) VALUES ($1, $2)
		ON CONFLICT (tenant_id, name) DO UPDATE SET name = EXCLUDED.name
		RETURNING id::text`, tid, *zone).Scan(&id)
	return &id, err
}

func isUnique(err error, constraint string) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == "23505" && pg.ConstraintName == constraint
}
