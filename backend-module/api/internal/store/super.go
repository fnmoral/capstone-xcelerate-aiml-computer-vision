package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Super admins (SUPER_ADMIN_EMAILS) run the platform: they are admins of every
// organization, can create, delete and restore organizations, and change each
// organization's fall-detection rules. They are set on the server only, never in the app.

func init() {
	migrations = append(migrations,
		`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`, // deleted organizations are erased 30 days later
	)
}

// OrgRetention is how long a deleted organization can be restored before it is erased.
const OrgRetention = 30 * 24 * time.Hour

var (
	ErrHomeOrg       = errors.New("the home organization (with the gateway and fall detector) can't be deleted")
	ErrOrgNotDeleted = errors.New("this organization isn't deleted")
)

// SetSuperAdmins sets the super admins' emails (lower case).
func (s *Store) SetSuperAdmins(emails []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.supers = nil
	for _, e := range emails {
		if e = strings.ToLower(strings.TrimSpace(e)); e != "" {
			s.supers = append(s.supers, e)
		}
	}
}

// superEmails returns the super admins' emails (never nil, for ANY($n) in SQL).
func (s *Store) superEmails() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string{}, s.supers...)
}

// EnsureSuperMemberships makes every super admin who has an account an admin of every
// active organization. Returns how many memberships were added or raised to admin.
func (s *Store) EnsureSuperMemberships(ctx context.Context) (int64, error) {
	supers := s.superEmails()
	if len(supers) == 0 {
		return 0, nil
	}
	tag, err := s.pool.Exec(ctx, `
		INSERT INTO memberships (tenant_id, user_id, role)
		SELECT t.id, u.id, 'admin' FROM tenants t CROSS JOIN users u
		WHERE t.status = 'active' AND u.email = ANY($1::citext[]) AND u.is_active AND u.guest_link_id IS NULL
		ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = 'admin' WHERE memberships.role <> 'admin'`, supers)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// OrgSummary is one organization in the super admin's list.
type OrgSummary struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	Status    string     `json:"status"` // active | deleted
	CreatedAt time.Time  `json:"created_at"`
	DeletedAt *time.Time `json:"deleted_at"`
	EraseAt   *time.Time `json:"erase_at"` // deleted: erased for good at this time
	Members   int        `json:"members"`  // people, not counting super admins
	Cameras   int        `json:"cameras"`
	Home      bool       `json:"home"` // has the gateway and fall detector; can't be deleted
}

// AllOrgs lists every organization (active first, then deleted), for super admins.
func (s *Store) AllOrgs(ctx context.Context) ([]OrgSummary, error) {
	home, _ := s.HomeTenantID(ctx)
	rows, err := s.pool.Query(ctx, `
		SELECT t.id::text, t.name, t.status, t.created_at, t.deleted_at,
		       (SELECT count(*) FROM memberships m JOIN users u ON u.id = m.user_id
		         WHERE m.tenant_id = t.id AND u.guest_link_id IS NULL AND NOT (u.email = ANY($1::citext[]))),
		       (SELECT count(*) FROM cameras c WHERE c.tenant_id = t.id)
		FROM tenants t WHERE t.status IN ('active', 'deleted')
		ORDER BY t.status = 'deleted', lower(t.name)`, s.superEmails())
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (OrgSummary, error) {
		var o OrgSummary
		err := r.Scan(&o.ID, &o.Name, &o.Status, &o.CreatedAt, &o.DeletedAt, &o.Members, &o.Cameras)
		if o.DeletedAt != nil {
			at := o.DeletedAt.Add(OrgRetention)
			o.EraseAt = &at
		}
		o.Home = o.ID == home
		return o, err
	})
}

// CreateOrg creates an empty organization; the super admins become its admins.
func (s *Store) CreateOrg(ctx context.Context, name, actorID, actorName string) (string, error) {
	var id string
	err := s.plain(ctx, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `INSERT INTO tenants (name, slug) VALUES ($1, $2) RETURNING id::text`,
			name, newSlug(name)).Scan(&id); err != nil {
			return err
		}
		return auditTx(ctx, tx, id, &actorID, actorName, "org.created", "org", id,
			map[string]any{"message": "Organization created by a super admin", "name": name})
	})
	if err != nil {
		return "", err
	}
	_, err = s.EnsureSuperMemberships(ctx)
	return id, err
}

// DeleteOrg switches an organization off: nobody can open it (sessions in it end) and it
// is erased for good after OrgRetention unless restored. The home organization stays.
func (s *Store) DeleteOrg(ctx context.Context, id, actorID, actorName string) error {
	home, _ := s.HomeTenantID(ctx)
	if id == home {
		return ErrHomeOrg
	}
	return s.plain(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `UPDATE tenants SET status = 'deleted', deleted_at = now()
			WHERE id::text = $1 AND status = 'active'`, id)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		if _, err := tx.Exec(ctx, `DELETE FROM sessions WHERE tenant_id::text = $1`, id); err != nil {
			return err
		}
		return auditTx(ctx, tx, id, &actorID, actorName, "org.deleted", "org", id,
			map[string]any{"message": "Organization deleted (can be restored for 30 days)"})
	})
}

// RestoreOrg brings back a deleted organization (before it is erased).
func (s *Store) RestoreOrg(ctx context.Context, id, actorID, actorName string) error {
	err := s.plain(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `UPDATE tenants SET status = 'active', deleted_at = NULL
			WHERE id::text = $1 AND status = 'deleted'`, id)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrOrgNotDeleted
		}
		return auditTx(ctx, tx, id, &actorID, actorName, "org.restored", "org", id,
			map[string]any{"message": "Organization restored"})
	})
	if err != nil {
		return err
	}
	_, err = s.EnsureSuperMemberships(ctx)
	return err
}

// Tables whose rows don't go with their organization automatically (no ON DELETE CASCADE
// to tenants), children before parents. The rest go with the tenants row.
var orgDataTables = []string{
	"alert_deliveries", "notification_deliveries", "model_predictions", "frame_embeddings",
	"incident_cameras", "shared_links", "reports", "alerts", "events", "frames", "incidents",
	"phone_cameras", "account_emails", "audit_logs", "system_logs",
}

// PurgeDeletedOrgs erases organizations deleted more than OrgRetention ago, with all
// their data, and the accounts that belonged only to them. Returns how many.
func (s *Store) PurgeDeletedOrgs(ctx context.Context) (int, error) {
	rows, err := s.pool.Query(ctx, `SELECT id::text FROM tenants WHERE status = 'deleted' AND deleted_at < now() - $1::interval`,
		fmt.Sprintf("%d seconds", int(OrgRetention.Seconds())))
	if err != nil {
		return 0, err
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return 0, err
	}
	n := 0
	for _, id := range ids {
		if err := s.eraseOrg(ctx, id); err != nil {
			return n, fmt.Errorf("erasing organization %s: %w", id, err)
		}
		n++
	}
	return n, nil
}

func (s *Store) eraseOrg(ctx context.Context, id string) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op after commit
	var members []string
	mrows, err := tx.Query(ctx, `SELECT user_id::text FROM memberships WHERE tenant_id::text = $1`, id)
	if err != nil {
		return err
	}
	if members, err = pgx.CollectRows(mrows, pgx.RowTo[string]); err != nil {
		return err
	}
	for _, table := range orgDataTables {
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT to_regclass($1) IS NOT NULL`, "public."+table).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			continue
		}
		if _, err := tx.Exec(ctx, `DELETE FROM `+table+` WHERE tenant_id::text = $1`, id); err != nil {
			return fmt.Errorf("%s: %w", table, err)
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM tenants WHERE id::text = $1`, id); err != nil {
		return fmt.Errorf("tenants: %w", err)
	}
	// Accounts that were only in this organization have no use any more.
	if _, err := tx.Exec(ctx, `DELETE FROM users u WHERE u.id::text = ANY($1)
		AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id)`, members); err != nil {
		return fmt.Errorf("users: %w", err)
	}
	return tx.Commit(ctx)
}

// FallRules are the organization's own fall-detection and alert rules (changed by a super
// admin), in the fall rule's parsed_config.fall_rules; ml-service reloads them every 15 s.
// A missing key uses the detector's default (config.yaml).
func (s *Store) FallRules(ctx context.Context) (map[string]float64, error) {
	out := map[string]float64{}
	err := s.tx(ctx, func(tx pgx.Tx, tid string) error {
		var raw []byte
		err := tx.QueryRow(ctx, `SELECT coalesce(parsed_config->'fall_rules', '{}')::text FROM rules
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

// SetFallRules saves the organization's rules (an empty map restores the defaults) and
// records who changed what. Creates the tenant's fall rule if it has none.
func (s *Store) SetFallRules(ctx context.Context, rules map[string]float64, actor string) error {
	return s.tx(ctx, func(tx pgx.Tx, tid string) error {
		var ruleID string
		var before []byte
		err := tx.QueryRow(ctx, `SELECT id::text, coalesce(parsed_config->'fall_rules', '{}')::text FROM rules
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
		if len(rules) == 0 {
			_, err = tx.Exec(ctx, `UPDATE rules SET parsed_config = parsed_config - 'fall_rules', updated_at = now()
				WHERE id::text = $1`, ruleID)
		} else {
			var after []byte
			if after, err = json.Marshal(rules); err != nil {
				return err
			}
			_, err = tx.Exec(ctx, `UPDATE rules SET parsed_config = parsed_config || jsonb_build_object('fall_rules', $1::jsonb),
				updated_at = now() WHERE id::text = $2`, string(after), ruleID)
		}
		if err != nil {
			return err
		}
		msg, to := "Detection rules changed", any(rules)
		if len(rules) == 0 {
			msg, to = "Detection rules restored to the defaults", map[string]float64{}
		}
		return audit(ctx, tx, tid, actor, "settings.rules", "settings", ruleID, map[string]any{
			"message": msg, "from": json.RawMessage(before), "to": to,
		})
	})
}
