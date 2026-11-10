# syntax=docker/dockerfile:1
# stream-hub: receives H.264 from gateways (TCP :8090), serves it to browsers over
# WebSocket (:9000), forwards it to ml-service, and records incident clips (via ffmpeg,
# remuxed from the camera's own H.264/H.265, no re-encoding) and snapshots under /app/data.
#
#   docker build -t stream-hub .
#   docker run -p 9000:9000 -p 8090:8090 -v stream-hub-data:/app/data \
#     -e STREAM_HUB_AI_SERVER_ADDR=ml-service:9999 stream-hub

FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/stream-hub ./cmd/api

FROM alpine:3.24
# ffmpeg: remuxes each incident's clip to MP4 (no re-encoding, so this costs almost no CPU).
RUN apk add --no-cache ca-certificates tzdata ffmpeg \
 && adduser -D -u 1000 app \
 && mkdir -p /app/data/recordings && chown -R app:app /app
COPY --from=build /out/stream-hub /usr/local/bin/stream-hub
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# config.json is generated from these on every start (stream-hub never writes it).
# Incident clips and snapshots live under STREAM_HUB_RECORDINGS_DIR, on the /app/data volume.
ENV STREAM_HUB_HTTP_ADDR=:9000 \
    STREAM_HUB_TCP_ADDR=:8090 \
    STREAM_HUB_AI_SERVER_ADDR=ml-service:9999 \
    STREAM_HUB_RECORDINGS_DIR=/app/data/recordings \
    STREAM_HUB_RETENTION_DAYS=30 \
    STREAM_HUB_MAX_TOTAL_GB=10 \
    GIN_MODE=release
USER app
WORKDIR /app
VOLUME /app/data
EXPOSE 9000 8090
ENTRYPOINT ["sh", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["stream-hub"]