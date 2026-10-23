#!/bin/sh
# stream-hub reads ./config.json at startup and never changes it, so the environment is
# the source of truth: rewrite it on every start.
set -eu

cat > config.json <<EOF
{
  "http_addr": "${STREAM_HUB_HTTP_ADDR}",
  "tcp_addr": "${STREAM_HUB_TCP_ADDR}",
  "ai_server_addr": "${STREAM_HUB_AI_SERVER_ADDR}"
}
EOF
echo "docker-entrypoint: http=${STREAM_HUB_HTTP_ADDR} tcp=${STREAM_HUB_TCP_ADDR} ai=${STREAM_HUB_AI_SERVER_ADDR}"

exec "$@"
