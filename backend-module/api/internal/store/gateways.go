// Package store holds the PostgreSQL queries of the backend API.
package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// Gateway represents the structure for a registered gateway entity.
type Gateway struct {
	ID            string  `json:"id"`
	TenantID      string  `json:"tenant_id"`
	SiteID        *string `json:"site_id"`
	Name          string  `json:"name"`
	AuthTokenHash string  `json:"auth_token_hash"`
}

// RegisterGateway validates if the tenant exists by slug, extracts its UUID,
// registers or updates the gateway in the database, and returns both tenant_id and gateway_id.
func (s *Store) RegisterGateway(ctx context.Context, tenantSlug string, gatewayName string, authTokenHash string) (string, string, error) {
	var tenantID string

	// Step 1: Validate tenant by slug and extract the tenant_id UUID.
	err := s.pool.QueryRow(ctx,
		`SELECT id::text FROM tenants WHERE slug = $1 LIMIT 1`, tenantSlug).Scan(&tenantID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", "", fmt.Errorf("tenant with slug %q not found", tenantSlug)
		}
		return "", "", err
	}

	var gatewayID string

	// Step 2: Insert or update the gateway.
	// The database will automatically generate a UUID via gen_random_uuid() if not provided.
	query := `
		INSERT INTO gateways (tenant_id, name, auth_token_hash)
		VALUES ($1, $2, $3)
		ON CONFLICT DO NOTHING
		RETURNING id::text
	`

	// If it already exists based on name/tenant, we fetch its ID instead.
	err = s.pool.QueryRow(ctx, query, tenantID, gatewayName, authTokenHash).Scan(&gatewayID)
	if err != nil {
		// If no row was returned due to conflict, fetch the existing gateway ID
		if errors.Is(err, pgx.ErrNoRows) {
			err = s.pool.QueryRow(ctx,
				`SELECT id::text FROM gateways WHERE tenant_id = $1 AND name = $2 LIMIT 1`, tenantID, gatewayName).Scan(&gatewayID)
			if err != nil {
				return "", "", err
			}
		} else {
			return "", "", err
		}
	}

	return tenantID, gatewayID, nil
}
