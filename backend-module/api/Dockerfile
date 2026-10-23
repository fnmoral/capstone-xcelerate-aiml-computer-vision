# syntax=docker/dockerfile:1
# FallGuard core backend API (Module 2): the REST API the frontend talks to.
FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/backend-api ./cmd/api

FROM alpine:3.24
RUN apk add --no-cache ca-certificates tzdata && adduser -D -u 1000 app
COPY --from=build /out/backend-api /usr/local/bin/backend-api
USER app
ENV API_ADDR=:8000
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=3s --retries=4 CMD wget -qO- http://127.0.0.1:8000/api/health >/dev/null || exit 1
CMD ["backend-api"]
