#!/bin/bash
# Creates monthly partitions ahead of time, as the table owner: once now, then every day.
# Rows for a month without a partition would land in the DEFAULT partition, and a month
# can't be split off the default partition later while it holds rows for that month.
set -uo pipefail

months="${MONTHS_AHEAD:-3}"
export PGOPTIONS="-c client_min_messages=warning"   # no "already exists, skipping" notices
while true; do
    if psql -v ON_ERROR_STOP=1 -qtA \
        -c "SELECT create_monthly_partitions(date_trunc('month', now())::date, ${months})" >/dev/null; then
        echo "$(date -u +%FT%TZ) partitions ensured for this month + $((months - 1)) ahead"
    else
        echo "$(date -u +%FT%TZ) could not create partitions; retrying in 60s" >&2
        sleep 60
        continue
    fi
    sleep 86400
done
