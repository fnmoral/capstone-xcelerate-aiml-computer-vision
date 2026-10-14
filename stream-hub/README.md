# Stream Hub
A lightweight, high-performance Go microservice designed to ingest, manage, and broadcast real-time H.264 video streams from edge gateways to frontend clients (WebSockets) 
and external processing modules (such as Python/AI workers).

## Architecture
```json
stream-hub
 ┣ cmd
 ┃ ┗ api
 ┃ ┃ ┗ main.go         # Application entry point
 ┣ internal
 ┃ ┣ api
 ┃ ┃ ┗ handler.go      # HTTP and WebSocket endpoints (Gin)
 ┃ ┣ config
 ┃ ┃ ┗ config.go       # Configuration loader
 ┃ ┣ database          # Database persistence layer
 ┃ ┣ hub
 ┃ ┃ ┣ ai_worker.go    # External stream forwarder (TCP client to Python/AI)
 ┃ ┃ ┣ broker.go       # Central pub/sub stream manager
 ┃ ┃ ┗ client.go       # WebSocket client handler
 ┃ ┗ ingestion
 ┃ ┃ ┣ protocol.go     # TCP handshake and protocol parser
 ┃ ┃ ┗ server.go       # TCP ingestion server for incoming gateways
 ┣ README.md
 ┣ config.json         # Runtime configuration file
 ┣ go.mod
 ┗ go.sum
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