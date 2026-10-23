# Gateway-back

A Go-based gateway service that connects to IP cameras over RTSP, extracts H.264
keyframes, and relays the video stream to a remote cloud server over TCP.

The service exposes a REST API built with [Gin](https://github.com/gin-gonic/gin),
persists camera data using SQLite (via [sqlx](https://github.com/jmoiron/sqlx)),
and relies on [gortsplib](https://github.com/bluenviron/gortsplib) for RTSP
communication.

---

## Features

- **RTSP client per camera** — connects to IP cameras, receives the video stream,
  and automatically reconnects on connection loss.
- **H.264 keyframe extraction** — inspects RTP packets, decodes NALUs, and
  detects I-Frames (IDR) without interrupting the video flow.
- **TCP relay to cloud** — sends NALUs to a remote server using a custom
  length-prefixed protocol with an initial handshake identifying the camera.
- **Camera management API** — create, list, and remove cameras through REST
  endpoints: up to 5 cameras **streaming** at once per gateway and up to 50 saved; the rest
  stay paused (standby) and can be switched in with pause / resume (`GET /gateway/actions/limits`).
- **Hot configuration updates** — update the cloud server address and server
  port at runtime, persisted to `config.json` and applied to active streams.
- **Stream restoration on startup** — restores all previously saved camera
  streams from the SQLite database when the gateway starts.
- **Concurrency-safe** — all shared state (stream manager, frame senders, RTSP
  clients) is protected with mutexes.

---

## Architecture

```json
gateway-back/
├── cmd/
│ └── api/
│   ├── dist/ # Compiled frontend assets (served by the Go backend)
│   │ ├── assets/
│   │ │ ├── index-BSdzWjXO.js # Bundled React app
│   │ │ └── index-C1EEWJgp.css # Bundled Tailwind CSS
│   │ ├── favicon.svg
│   │ ├── icons.svg
│   │ └── index.html # SPA entry point
│ └── main.go # Application entry point
├── internal/
│ ├── camera/
│ │ ├── handler.go # HTTP endpoints (Gin)
│ │ ├── model.go # Structs with JSON and DB tags
│ │ ├── repository.go # Manual SQL queries (sqlx)
│ │ └── service.go # Business logic (5 streaming / 50 saved, stream relay)
│ ├── config/
│ │ ├── config.go # Config struct, loading and saving
│ │ └── handler.go # Config HTTP endpoints (get/update)
│ ├── database/
│ │ └── sqlite.go # SQLite connection and schema initialization
│ ├── extractor/
│ │ └── keyframe.go # RTP inspection and H.264 keyframe detection
│ ├── network/
│ │ └── frame_sender.go # TCP sender with handshake and NALU framing
│ ├── rtsp/
│ │ └── client.go # RTSP client with auto-reconnect and streaming
│ └── stream/
│   └── manager.go # Coordinates multiple RTSP clients per camera
├── .gitignore
├── README.md
├── config.json # Runtime configuration file
├── gateway.db # SQLite database file
├── go.mod
└── go.sum
```

## Project structure

| Path | Description |
|---|---|
| `cmd/api/main.go` | Application entry point. Loads config, initializes the DB, sets up the stream manager and camera service, registers HTTP routes, and starts the Gin server. |
| `internal/camera/handler.go` | HTTP endpoints (Gin) for creating, listing, and removing cameras. |
| `internal/camera/model.go` | Camera structs with JSON and database tags, plus DTOs. |
| `internal/camera/repository.go` | Manual SQL queries using `sqlx`. |
| `internal/camera/service.go` | Business logic: at most `MaxStreaming` (5) streaming and `MaxSaved` (50) saved cameras (a new camera over 5 is saved paused; resume returns 409 at 5), manages stream relays, and restores saved streams on startup. |
| `internal/config/config.go` | `Config` struct plus `LoadConfig` and `SaveConfig` functions. |
| `internal/config/handler.go` | HTTP endpoints to get and update the configuration at runtime. |
| `internal/database/sqlite.go` | SQLite connection setup and schema initialization. |
| `internal/extractor/keyframe.go` | Decodes RTP packets and detects H.264 keyframes (IDR / NALU type 5). |
| `internal/network/frame_sender.go` | TCP sender with handshake and length-prefixed NALU framing. |
| `internal/rtsp/client.go` | RTSP client that connects to a camera, streams packets, and reconnects automatically. |
| `internal/stream/manager.go` | Coordinates multiple RTSP clients (one per camera) and the cloud server address. |
| `config.json` | Runtime configuration file (cloud address, server port). |
| `gateway.db` | SQLite database file (created automatically on first run). |
| `go.mod` / `go.sum` | Go module definition and dependency checksums. |



### Package responsibilities

| Package | Responsibility |
|---|---|
| `cmd/api` | Bootstraps the application: loads config, initializes DB, stream manager, service, and HTTP server. |
| `camera` | Camera domain: HTTP handlers, models, repository, and business logic (5 streaming / 50 saved). |
| `config` | Configuration struct plus handlers for reading and updating it at runtime. |
| `database` | SQLite initialization and schema creation. |
| `extractor` | Decodes RTP packets and detects H.264 keyframes (IDR / NALU type 5). |
| `network` | `FrameSender` handles the TCP connection, handshake, and NALU framing. |
| `rtsp` | `RTSPClient` connects to a camera, streams packets, and reconnects automatically. |
| `stream` | `StreamManager` coordinates all RTSP clients and the cloud server address. |

---

## Requirements

- Go 1.21 or higher
- A SQLite database file (`gateway.db`) — created automatically on first run
- A remote cloud server listening over TCP to receive the relayed streams
- Network access to the IP cameras via RTSP

---

## Configuration

The gateway reads its configuration from `config.json` in the working directory.

```json
{
  "cloud_address": "127.0.0.1:9000",
  "server_port": "8080"
}
```

## Getting Started

### Prerequisites

- **Go** `>= 1.22` — [Download](https://go.dev/dl/)
- **Gin** framework (installed automatically via Go Modules)

### 1. Install dependencies

```bash
go mod download
```

This command downloads all dependencies declared in `go.mod` and places them in your local module cache (`$GOPATH/pkg/mod`)[citation:1][citation:14].

### 2. Run the server

```bash
go run cmd/api/main.go
```

The API server will start and be available at [http://localhost:8080](http://localhost:8080) (or the port configured in `config.json`).

## Available Commands

```bash
# Download all dependencies from go.mod
go mod download

# Run the API server directly
go run cmd/api/main.go

# Build a production binary
go build -o bin/api cmd/api/main.go

# Clean up unused dependencies and add missing ones
go mod tidy

# Verify dependency integrity
go mod verify

# List all module dependencies
go list -m all
```

## About Go Modules

This project uses **Go Modules** for dependency management — the official standard since Go 1.11 and the default since Go 1.16[citation:13][citation:16].

- **`go.mod`**: Declares the module path, Go version, and required dependencies.
- **`go.sum`**: Contains cryptographic hashes to ensure dependency integrity and reproducibility[citation:12][citation:16].

### Adding a new dependency

```bash
go get github.com/gin-gonic/gin
```

This updates `go.mod` and downloads the package into the module cache[citation:6][citation:13].