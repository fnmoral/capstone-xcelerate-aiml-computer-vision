// Package store holds the PostgreSQL queries of the backend API.
//
// Every query runs in a transaction with app.tenant_id set (row-level security). The tenant
// (organization) comes from the request context (WithTenant: the signed-in user's current
// organization); background jobs without one use the home tenant (TENANT, a tenants.slug or
// UUID), which owns the gateway and the ML pipeline.
package store

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrNotFound is returned when a row doesn't exist for this tenant.
var ErrNotFound = errors.New("not found")

// Store wraps the connection pool and the resolved tenant.
type Store struct {
	pool   *pgxpool.Pool
	tenant string // slug or UUID as configured

	mu       sync.Mutex
	tenantID string // resolved UUID
}

// Open creates the pool. It doesn't fail if the database isn't up yet; queries retry it.
func Open(url, tenant string) (*Store, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("parse DATABASE_URL: %w", err)
	}
	cfg.MaxConns = 10
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		return nil, err
	}
	return &Store{pool: pool, tenant: tenant}, nil
}

func (s *Store) Close() { s.pool.Close() }

// Ping checks the database is reachable.
func (s *Store) Ping(ctx context.Context) error { return s.pool.Ping(ctx) }

// DatabaseSize is the database's size on disk, in bytes.
func (s *Store) DatabaseSize(ctx context.Context) (int64, error) {
	var n int64
	err := s.pool.QueryRow(ctx, `SELECT pg_database_size(current_database())`).Scan(&n)
	return n, err
}

type tenantKey struct{}

// WithTenant returns a context whose queries run for the given tenant UUID.
func WithTenant(ctx context.Context, tenantID string) context.Context {
	return context.WithValue(ctx, tenantKey{}, tenantID)
}

// TenantID is the tenant queries run for: the context's (WithTenant), else the home tenant.
func (s *Store) TenantID(ctx context.Context) (string, error) {
	if tid, ok := ctx.Value(tenantKey{}).(string); ok && tid != "" {
		return tid, nil
	}
	return s.HomeTenantID(ctx)
}

// HomeTenantID resolves the configured tenant (slug or UUID) once.
func (s *Store) HomeTenantID(ctx context.Context) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.tenantID != "" {
		return s.tenantID, nil
	}
	var id string
	err := s.pool.QueryRow(ctx,
		`SELECT id::text FROM tenants WHERE id::text = $1 OR slug = $1 LIMIT 1`, s.tenant).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", fmt.Errorf("tenant %q not found in the tenants table", s.tenant)
	}
	if err != nil {
		return "", err
	}
	s.tenantID = id
	return id, nil
}

// tx runs fn in a transaction scoped to the tenant (sets app.tenant_id for RLS).
func (s *Store) tx(ctx context.Context, fn func(pgx.Tx, string) error) error {
	tid, err := s.TenantID(ctx)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op after commit
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tid); err != nil {
		return err
	}
	if err := fn(tx, tid); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
