# syntax=docker/dockerfile:1
# gateway-back: RTSP cameras in, H.264 out to stream-hub, plus the gateway web UI on :8080.
# The UI is the prebuilt bundle in cmd/api/dist (built from gateway-ui), embedded at compile time.
#
#   docker build -t gateway-back .
#   docker run -p 8080:8080 -v gateway-data:/data gateway-back

FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# The SQLite driver is pure Go, so the binary is static and needs no C libraries.
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/gateway ./cmd/api

FROM alpine:3.24
RUN apk add --no-cache ca-certificates tzdata \
 && adduser -D -u 1000 app \
 && mkdir -p /data && chown app:app /data
COPY --from=build /out/gateway /usr/local/bin/gateway
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# config.json and gateway.db live in the working directory, kept on the /data volume.
# These only seed config.json on first start; after that the UI's settings page owns it.
ENV GATEWAY_CLOUD_ADDRESS=stream-hub:8090 \
    GATEWAY_TENANT_ID=demo-facility
USER app
WORKDIR /data
VOLUME /data
EXPOSE 8080
ENTRYPOINT ["sh", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["gateway"]
