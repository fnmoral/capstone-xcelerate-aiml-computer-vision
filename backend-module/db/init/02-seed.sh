#!/bin/bash
# First start only: load the dev seed data unless SEED_DEMO_DATA=false.
set -euo pipefail

if [[ "${SEED_DEMO_DATA:-true}" =~ ^(1|true|yes)$ ]]; then
    echo "02-seed: loading /seed/seed.sql (demo data; set SEED_DEMO_DATA=false to skip)"
    psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -f /seed/seed.sql
else
    echo "02-seed: SEED_DEMO_DATA=${SEED_DEMO_DATA}; skipping demo data"
fi
