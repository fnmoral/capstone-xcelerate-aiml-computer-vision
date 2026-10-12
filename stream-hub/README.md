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