#!/bin/sh
# stream-hub reads ./config.json at startup and never changes it, so the environment is
# the source of truth: rewrite it on every start.
set -eu

mkdir -p "${STREAM_HUB_RECORDINGS_DIR}"

cat > config.json <<EOF
{
  "http_addr": "${STREAM_HUB_HTTP_ADDR}",
  "tcp_addr": "${STREAM_HUB_TCP_ADDR}",
  "ai_server_addr": "${STREAM_HUB_AI_SERVER_ADDR}",
  "recordings": {
    "dir": "${STREAM_HUB_RECORDINGS_DIR}",
    "retention_days": ${STREAM_HUB_RETENTION_DAYS},
    "max_total_gb": ${STREAM_HUB_MAX_TOTAL_GB}
  }
}
EOF
echo "docker-entrypoint: http=${STREAM_HUB_HTTP_ADDR} tcp=${STREAM_HUB_TCP_ADDR} ai=${STREAM_HUB_AI_SERVER_ADDR}" \
     "recordings=${STREAM_HUB_RECORDINGS_DIR} (keep ${STREAM_HUB_RETENTION_DAYS}d / ${STREAM_HUB_MAX_TOTAL_GB}GB)"

exec "$@"