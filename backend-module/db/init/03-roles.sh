#!/bin/bash
# First start only: create the ml_service login role with only what ml-service needs
# (see "ML SERVICE ROLE" at the end of schema.sql). ml-service sets app.tenant_id per
# transaction, so row-level security applies to it.
set -euo pipefail

if [[ -z "${ML_SERVICE_PASSWORD:-}" ]]; then
    echo "03-roles: ML_SERVICE_PASSWORD not set; skipping ml_service role" >&2
    exit 0
fi

echo "03-roles: creating role ml_service"
# The password is passed as a psql variable (:'pw'), so it is quoted safely.
# Safe to re-run: creates the role if missing, otherwise just resets its password.
psql -v ON_ERROR_STOP=1 -v pw="$ML_SERVICE_PASSWORD" --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'EOSQL'
SELECT 'CREATE ROLE ml_service LOGIN'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ml_service') \gexec
ALTER ROLE ml_service LOGIN PASSWORD :'pw';
GRANT CONNECT ON DATABASE :"DBNAME" TO ml_service;
GRANT SELECT ON tenants, cameras, zones, rules TO ml_service;
GRANT SELECT, INSERT, UPDATE ON incidents, incident_cameras, alerts TO ml_service;
GRANT INSERT ON model_predictions TO ml_service;
GRANT EXECUTE ON FUNCTION create_monthly_partitions(date, int) TO ml_service;
EOSQL
