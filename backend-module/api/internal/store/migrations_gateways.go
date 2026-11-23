package store

// Migrations for gateways: several per organization (the cloud one on the server, on-site
// ones next to the cameras), one in use at a time. Safe to run again; schema.sql has the same
// columns for fresh installs.
func init() {
	migrations = append(migrations,
		// Gateway sign-up used to insert a row at every start ("ON CONFLICT DO NOTHING" had no
		// unique key): keep the oldest row per name, then make the name unique.
		`DELETE FROM gateways g USING gateways k
			WHERE g.tenant_id = k.tenant_id AND g.name = k.name AND (g.created_at, g.id) > (k.created_at, k.id)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS gateways_tenant_name ON gateways (tenant_id, name)`,
		// display_name: the place, shown in the app ("Cloud", "Office server"); location: optional
		// detail. url: how the API reaches it (sent by the gateway when it signs up). kind:
		// cloud (on the server; phone cameras only) or onsite (next to the cameras).
		`ALTER TABLE gateways
			ADD COLUMN IF NOT EXISTS display_name TEXT,
			ADD COLUMN IF NOT EXISTS location TEXT,
			ADD COLUMN IF NOT EXISTS url TEXT,
			ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'onsite'`,
		// The gateway the admin chose; NULL = automatic (on-site if one is online, else cloud).
		`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS active_gateway_id UUID REFERENCES gateways(id) ON DELETE SET NULL`,
	)
}
