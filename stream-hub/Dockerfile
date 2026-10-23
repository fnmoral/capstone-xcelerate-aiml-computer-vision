# syntax=docker/dockerfile:1
# stream-hub: receives H.264 from gateways (TCP :8090), serves it to browsers over
# WebSocket (:9000), and forwards it to ml-service.
#
#   docker build -t stream-hub .
#   docker run -p 9000:9000 -p 8090:8090 -e STREAM_HUB_AI_SERVER_ADDR=ml-service:9999 stream-hub

FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/stream-hub ./cmd/api

FROM alpine:3.24
RUN apk add --no-cache ca-certificates tzdata \
 && adduser -D -u 1000 app \
 && mkdir -p /app && chown app:app /app
COPY --from=build /out/stream-hub /usr/local/bin/stream-hub
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# config.json is generated from these on every start (stream-hub never writes it).
ENV STREAM_HUB_HTTP_ADDR=:9000 \
    STREAM_HUB_TCP_ADDR=:8090 \
    STREAM_HUB_AI_SERVER_ADDR=ml-service:9999 \
    GIN_MODE=release
USER app
WORKDIR /app
EXPOSE 9000 8090
ENTRYPOINT ["sh", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["stream-hub"]
