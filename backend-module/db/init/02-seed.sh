#!/bin/bash
# First start only: load the dev seed data unless SEED_DEMO_DATA=false.
#
# Without the demo data, a clean database still gets what the services need to run: the
# tenant they serve (TENANT_SLUG, default demo-facility, as the API's TENANT and
# ml-service's default_tenant_id) and its fall-detection rule. Add cameras in the app.
set -euo pipefail

if [[ "${SEED_DEMO_DATA:-true}" =~ ^(1|true|yes)$ ]]; then
    echo "02-seed: loading /seed/seed.sql (demo data; set SEED_DEMO_DATA=false to skip)"
    psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -f /seed/seed.sql
else
    slug="${TENANT_SLUG:-demo-facility}"
    echo "02-seed: SEED_DEMO_DATA=${SEED_DEMO_DATA}; no demo data, creating tenant '${slug}' only"
    psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
        -v slug="$slug" -v name="${TENANT_NAME:-FallGuard}" <<'SQL'
INSERT INTO tenants (name, slug, plan, max_cameras)
VALUES (:'name', :'slug', 'pro', 50)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO rules (tenant_id, name, prompt_text, parsed_config, severity)
SELECT id, 'Fall detection', 'Alert me when a person falls and stays on the floor',
       '{"event_type": "fall"}', 'high'
FROM tenants WHERE slug = :'slug'
  AND NOT EXISTS (SELECT 1 FROM rules r WHERE r.tenant_id = tenants.id AND r.parsed_config->>'event_type' = 'fall');
SQL
fi
