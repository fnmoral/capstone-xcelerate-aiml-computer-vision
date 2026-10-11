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
  endpoints, with a hard limit of 3 cameras per gateway.
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
│ └── main.go # Application entry point
├── internal/
│ ├── camera/
│ │ ├── handler.go # HTTP endpoints (Gin)
│ │ ├── model.go # Structs with JSON and DB tags
│ │ ├── repository.go # Manual SQL queries (sqlx)
│ │ └── service.go # Business logic (max 3 cameras, stream relay)
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
│ └── manager.go # Coordinates multiple RTSP clients per camera
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
| `internal/camera/service.go` | Business logic: enforces the max of 3 cameras, manages stream relays, and restores saved streams on startup. |
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
| `camera` | Camera domain: HTTP handlers, models, repository, and business logic (max 3 cameras). |
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