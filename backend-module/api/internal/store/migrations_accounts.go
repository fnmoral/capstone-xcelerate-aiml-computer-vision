package store

// Migrations for user accounts, roles, notifications and incident reports. Each is safe to
// run again (they run at every start, after the ones in settings.go). schema.sql has the
// same tables for fresh installs.
func init() {
	migrations = append(migrations,
		// ---------- accounts ----------
		`ALTER TABLE users
			ADD COLUMN IF NOT EXISTS first_name TEXT,
			ADD COLUMN IF NOT EXISTS last_name TEXT,
			ADD COLUMN IF NOT EXISTS phone TEXT,
			ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ,
			ADD COLUMN IF NOT EXISTS failed_logins INT NOT NULL DEFAULT 0,
			ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ,
			ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ,
			ADD COLUMN IF NOT EXISTS last_tenant_id UUID`,
		// Roles are admin / member / viewer (owner and operator were the draft names).
		`ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_role_check`,
		`UPDATE memberships SET role = CASE role WHEN 'owner' THEN 'admin' WHEN 'operator' THEN 'member' ELSE role END
			WHERE role IN ('owner', 'operator')`,
		`ALTER TABLE memberships ADD CONSTRAINT memberships_role_check CHECK (role IN ('admin','member','viewer'))`,
		`ALTER TABLE memberships ADD COLUMN IF NOT EXISTS invited_by UUID`,
		`CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships (user_id)`,
		// Organization profile (report headers) and what members / viewers may do.
		`ALTER TABLE tenants
			ADD COLUMN IF NOT EXISTS profile JSONB NOT NULL DEFAULT '{}',
			ADD COLUMN IF NOT EXISTS role_permissions JSONB`,
		// Sessions: the browser holds a random token; only its hash is stored.
		`ALTER TABLE sessions
			ADD COLUMN IF NOT EXISTS token_hash TEXT,
			ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			ADD COLUMN IF NOT EXISTS ip TEXT,
			ADD COLUMN IF NOT EXISTS user_agent TEXT`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_token ON sessions (token_hash)`,
		`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id)`,
		// One-time links sent by email: verify the address, reset the password.
		`CREATE TABLE IF NOT EXISTS user_tokens (
			id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			purpose     TEXT NOT NULL CHECK (purpose IN ('verify_email','reset_password')),
			token_hash  TEXT NOT NULL UNIQUE,
			expires_at  TIMESTAMPTZ NOT NULL,
			used_at     TIMESTAMPTZ,
			created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_user_tokens_user ON user_tokens (user_id, purpose)`,
		`CREATE TABLE IF NOT EXISTS invitations (
			id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
			email       CITEXT NOT NULL,
			role        TEXT NOT NULL CHECK (role IN ('admin','member','viewer')),
			token_hash  TEXT NOT NULL UNIQUE,
			invited_by  UUID REFERENCES users(id) ON DELETE SET NULL,
			expires_at  TIMESTAMPTZ NOT NULL,
			accepted_at TIMESTAMPTZ,
			revoked_at  TIMESTAMPTZ,
			created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_invitations_tenant ON invitations (tenant_id, created_at DESC)`,

		// ---------- notifications ----------
		`CREATE TABLE IF NOT EXISTS notification_settings (
			tenant_id   UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
			config      JSONB NOT NULL DEFAULT '{}',   -- matrix, recipients, follow-ups, templates
			email_provider JSONB NOT NULL DEFAULT '{}', -- {type: log|smtp, host, port, ...}; secrets encrypted
			sms_provider   JSONB NOT NULL DEFAULT '{}', -- {type: log|twilio, account_sid, ...}; secrets encrypted
			enabled_at  TIMESTAMPTZ NOT NULL DEFAULT now(), -- alerts before this aren't sent
			updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
		)`,
		// One row per message (alert or follow-up) per recipient and channel.
		`CREATE TABLE IF NOT EXISTS notification_deliveries (
			id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
			alert_id    UUID,
			event       TEXT NOT NULL,                 -- alert | recovered | false_alarm | resolved | test
			channel     TEXT NOT NULL CHECK (channel IN ('email','sms')),
			recipient   TEXT NOT NULL,
			subject     TEXT,
			body        TEXT NOT NULL,
			status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','logged','failed')),
			attempts    INT NOT NULL DEFAULT 0,
			error       TEXT,
			next_try_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
			sent_at     TIMESTAMPTZ
		)`,
		`CREATE INDEX IF NOT EXISTS idx_notif_deliveries_tenant ON notification_deliveries (tenant_id, created_at DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_notif_deliveries_pending ON notification_deliveries (next_try_at) WHERE status = 'pending'`,
		// Which alert events were already turned into messages (so each goes out once).
		`CREATE TABLE IF NOT EXISTS notification_events (
			tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
			alert_id    UUID NOT NULL,
			event       TEXT NOT NULL,
			created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
			PRIMARY KEY (alert_id, event)
		)`,
		// Platform secret for encrypting provider passwords when APP_SECRET isn't set.
		`CREATE TABLE IF NOT EXISTS platform_secrets (
			name   TEXT PRIMARY KEY,
			value  TEXT NOT NULL
		)`,

		// ---------- incident reports ----------
		`ALTER TABLE reports
			ADD COLUMN IF NOT EXISTS form TEXT NOT NULL DEFAULT 'internal',
			ADD COLUMN IF NOT EXISTS created_by UUID,
			ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`,
		`ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_status_check`,
		`ALTER TABLE reports ADD CONSTRAINT reports_status_check CHECK (status IN ('draft','generated','reviewed','final'))`,
		// Deleted reports stay restorable for the organization's report_retention_days.
		`ALTER TABLE reports
			ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
			ADD COLUMN IF NOT EXISTS deleted_by UUID`,

		// View-only links to an incident's video, for people without an account (regulators).
		// No row-level security: the public page looks a token up before any tenant is known
		// (like invitations); every other query filters on tenant_id.
		`CREATE TABLE IF NOT EXISTS shared_links (
			id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			tenant_id      UUID NOT NULL,
			incident_id    UUID NOT NULL,
			recipient      TEXT NOT NULL,
			token_hash     TEXT NOT NULL UNIQUE,
			created_by     UUID,
			created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
			expires_at     TIMESTAMPTZ NOT NULL,
			revoked_at     TIMESTAMPTZ,
			revoked_by     UUID,
			views          INT NOT NULL DEFAULT 0,
			last_viewed_at TIMESTAMPTZ
		)`,
		`CREATE INDEX IF NOT EXISTS idx_shared_links_incident ON shared_links (tenant_id, incident_id)`,
	)
}
