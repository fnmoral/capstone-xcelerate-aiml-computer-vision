package main

import (
	"log"

	"stream-hub/internal/api"
	"stream-hub/internal/config"
	"stream-hub/internal/hub"
	"stream-hub/internal/ingestion"
	"stream-hub/internal/recording"

	"github.com/gin-gonic/gin"
)

func main() {
	// Load configuration (reads config.json or falls back to defaults)
	cfg, err := config.LoadConfig("config.json")
	if err != nil {
		log.Fatalf("Failed to load configuration: %v", err)
	}

	// Initialize the Central Stream Broker
	broker := hub.NewStreamBroker()

	// Incident clips and snapshots, kept on disk by the hub
	recordings, err := recording.NewManager(cfg.Recordings)
	if err != nil {
		log.Fatalf("Failed to start recordings: %v", err)
	}
	defer recordings.Close()

	// Start the TCP Ingestion Server in a background goroutine
	tcpServer := ingestion.NewServer(cfg.TCPAddr, cfg.AIServerAddr, broker, recordings)
	go func() {
		log.Printf("Starting TCP ingestion server on %s...", cfg.TCPAddr)
		if err := tcpServer.Start(); err != nil {
			log.Fatalf("TCP ingestion server failed: %v", err)
		}
	}()

	// Initialize Gin HTTP and WebSocket Server
	router := gin.Default()

	// Health, WebSocket and live video from the broker
	api.NewHandler(broker, cfg.Tenant).RegisterRoutes(router)

	// Stored incident snapshots and clips
	api.NewRecordingsHandler(recordings).RegisterRoutes(router)

	log.Printf("Starting HTTP/WebSocket server on %s...", cfg.HTTPAddr)
	if err := router.Run(cfg.HTTPAddr); err != nil {
		log.Fatalf("HTTP server failed: %v", err)
	}
}
