// Package store holds the PostgreSQL queries of the backend API.
package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// Gateway kinds: a cloud gateway runs on the server (it can only read phone cameras, which
// push to the relay); an on-site gateway runs next to the cameras.
const (
	GatewayCloud  = "cloud"
	GatewayOnsite = "onsite"
)

// Gateway is a registered gateway. Name is the gateway's own ID (GATEWAY_NAME_ID);
// DisplayName is the place shown in the app ("Cloud", "Office server").
type Gateway struct {
	ID          string     `json:"id"`
	Name        string     `json:"gateway_name_id"`
	DisplayName string     `json:"name"`
	Location    *string    `json:"location"`
	URL         string     `json:"-"` // how the API reaches it; never sent to the browser
	Kind        string     `json:"kind"`
	LastSeenAt  *time.Time `json:"last_seen_at"`
	CreatedAt   time.Time  `json:"created_at"`
	Cameras     int        `json:"cameras"`
}

// RegisterGateway signs a gateway up (or updates it) for the tenant with that slug and
// returns the tenant and gateway IDs. Called by the gateway at every start, so its address
// (url) and kind stay current; an empty url keeps the one saved before.
func (s *Store) RegisterGateway(ctx context.Context, tenantSlug, gatewayName, authTokenHash, url, kind string) (string, string, error) {
	var tenantID string
	err := s.pool.QueryRow(ctx, `SELECT id::text FROM tenants WHERE slug = $1 LIMIT 1`, tenantSlug).Scan(&tenantID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", fmt.Errorf("tenant with slug %q not found", tenantSlug)
	}
	if err != nil {
		return "", "", err
	}
	if kind != GatewayCloud {
		kind = GatewayOnsite
	}
	display := "On-site gateway"
	if kind == GatewayCloud {
		display = "Cloud"
	}
	var gatewayID string
	err = s.pool.QueryRow(ctx, `
		INSERT INTO gateways (tenant_id, name, auth_token_hash, url, kind, display_name, last_seen_at)
		VALUES ($1, $2, $3, nullif($4, ''), $5, $6, now())
		ON CONFLICT (tenant_id, name) DO UPDATE SET
			url = coalesce(nullif(EXCLUDED.url, ''), gateways.url),
			kind = EXCLUDED.kind,
			last_seen_at = now()
		RETURNING id::text`, tenantID, gatewayName, authTokenHash, url, kind, display).Scan(&gatewayID)
	return tenantID, gatewayID, err
}

// Gateways lists the tenant's gateways with how many cameras each has, oldest first.
func (s *Store) Gateways(ctx context.Context) ([]Gateway, error) {
	out := []Gateway{}
	err := s.tx(ctx, func(tx pgx.Tx, tid string) error {
		rows, err := tx.Query(ctx, `
			SELECT g.id::text, g.name, coalesce(g.display_name, g.name), g.location, coalesce(g.url, ''), g.kind,
			       g.last_seen_at, g.created_at,
			       (SELECT count(*) FROM cameras c WHERE c.gateway_id = g.id AND c.tenant_id = g.tenant_id)
			FROM gateways g WHERE g.tenant_id = $1 ORDER BY g.created_at, g.id`, tid)
		if err != nil {
			return err
		}
		out, err = pgx.CollectRows(rows, func(r pgx.CollectableRow) (Gateway, error) {
			var g Gateway
			err := r.Scan(&g.ID, &g.Name, &g.DisplayName, &g.Location, &g.URL, &g.Kind, &g.LastSeenAt, &g.CreatedAt, &g.Cameras)
			return g, err
		})
		return err
	})
	return out, err
}

// GatewaySeen records that a gateway answered (shown as "last seen").
func (s *Store) GatewaySeen(ctx context.Context, id string) error {
	return s.tx(ctx, func(tx pgx.Tx, tid string) error {
		_, err := tx.Exec(ctx, `UPDATE gateways SET last_seen_at = now() WHERE tenant_id = $1 AND id::text = $2`, tid, id)
		return err
	})
}

// UpdateGateway changes a gateway's name and location (nil = unchanged, "" = no location).
func (s *Store) UpdateGateway(ctx context.Context, id string, name, location *string, actor string) error {
	return s.tx(ctx, func(tx pgx.Tx, tid string) error {
		tag, err := tx.Exec(ctx, `UPDATE gateways SET display_name = coalesce($3, display_name),
			location = CASE WHEN $4::text IS NULL THEN location ELSE nullif($4, '') END
			WHERE tenant_id = $1 AND id::text = $2`, tid, id, name, location)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		return audit(ctx, tx, tid, actor, "gateway.updated", "gateway", id, map[string]any{
			"message": "Gateway details changed", "name": name, "location": location})
	})
}

// DeleteGateway forgets a gateway. Its cameras stay in the database (and history) unless
// removed first; they then show as not on any gateway.
func (s *Store) DeleteGateway(ctx context.Context, id, actor string) (string, error) {
	var name string
	err := s.tx(ctx, func(tx pgx.Tx, tid string) error {
		err := tx.QueryRow(ctx, `DELETE FROM gateways WHERE tenant_id = $1 AND id::text = $2
			RETURNING coalesce(display_name, name)`, tid, id).Scan(&name)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		return audit(ctx, tx, tid, actor, "gateway.removed", "gateway", id, map[string]any{
			"message": "Gateway removed: " + name})
	})
	return name, err
}

// ActiveGatewayID is the gateway the admin chose, or nil for automatic.
func (s *Store) ActiveGatewayID(ctx context.Context) (*string, error) {
	var id *string
	err := s.tx(ctx, func(tx pgx.Tx, tid string) error {
		return tx.QueryRow(ctx, `SELECT active_gateway_id::text FROM tenants WHERE id = $1`, tid).Scan(&id)
	})
	return id, err
}

// SetActiveGateway sets the gateway in use (nil = automatic); label names it in the log.
func (s *Store) SetActiveGateway(ctx context.Context, id *string, label, actor string) error {
	return s.tx(ctx, func(tx pgx.Tx, tid string) error {
		if id != nil {
			var ok bool
			if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM gateways WHERE tenant_id = $1 AND id::text = $2)`,
				tid, *id).Scan(&ok); err != nil {
				return err
			}
			if !ok {
				return ErrNotFound
			}
		}
		if _, err := tx.Exec(ctx, `UPDATE tenants SET active_gateway_id = $2::uuid WHERE id = $1`, tid, id); err != nil {
			return err
		}
		return audit(ctx, tx, tid, actor, "gateway.selected", "gateway", "", map[string]any{
			"message": "Gateway in use: " + label})
	})
}

// SetCamerasGateway records which gateway the cameras are on.
func (s *Store) SetCamerasGateway(ctx context.Context, gatewayID string, cameraIDs []string) error {
	if len(cameraIDs) == 0 {
		return nil
	}
	return s.tx(ctx, func(tx pgx.Tx, tid string) error {
		_, err := tx.Exec(ctx, `UPDATE cameras SET gateway_id = $2::uuid
			WHERE tenant_id = $1 AND id::text = ANY($3) AND gateway_id IS DISTINCT FROM $2::uuid`, tid, gatewayID, cameraIDs)
		return err
	})
}

// MarkSwitchPaused marks (on) or unmarks cameras paused because their gateway stopped being
// the one in use, so switching back resumes exactly those.
func (s *Store) MarkSwitchPaused(ctx context.Context, cameraIDs []string, on bool) error {
	if len(cameraIDs) == 0 {
		return nil
	}
	return s.tx(ctx, func(tx pgx.Tx, tid string) error {
		q := `UPDATE cameras SET metadata = metadata - 'paused_for_gateway_switch' WHERE tenant_id = $1 AND id::text = ANY($2)`
		if on {
			q = `UPDATE cameras SET metadata = metadata || '{"paused_for_gateway_switch": true}' WHERE tenant_id = $1 AND id::text = ANY($2)`
		}
		_, err := tx.Exec(ctx, q, tid, cameraIDs)
		return err
	})
}

// SwitchPausedIDs lists a gateway's cameras paused by a gateway switch.
func (s *Store) SwitchPausedIDs(ctx context.Context, gatewayID string) ([]string, error) {
	var out []string
	err := s.tx(ctx, func(tx pgx.Tx, tid string) error {
		rows, err := tx.Query(ctx, `SELECT id::text FROM cameras WHERE tenant_id = $1 AND gateway_id::text = $2
			AND coalesce((metadata->>'paused_for_gateway_switch')::boolean, false)`, tid, gatewayID)
		if err != nil {
			return err
		}
		out, err = pgx.CollectRows(rows, pgx.RowTo[string])
		return err
	})
	return out, err
}

// GatewayCameraIDs lists the cameras on a gateway.
func (s *Store) GatewayCameraIDs(ctx context.Context, gatewayID string) ([]string, error) {
	var out []string
	err := s.tx(ctx, func(tx pgx.Tx, tid string) error {
		rows, err := tx.Query(ctx, `SELECT id::text FROM cameras WHERE tenant_id = $1 AND gateway_id::text = $2`, tid, gatewayID)
		if err != nil {
			return err
		}
		out, err = pgx.CollectRows(rows, pgx.RowTo[string])
		return err
	})
	return out, err
}
