// Package main is the entry point for the gateway-back service.
//
// It loads the configuration, initializes the SQLite database, sets up the
// stream manager, restores previously saved camera streams, configures the
// HTTP handlers with Gin, and starts the HTTP server.
package main

import (
	"context"
	"log"

	"github.com/gin-gonic/gin"

	"gateway-back/internal/camera"
	"gateway-back/internal/config"
	"gateway-back/internal/database"
	"gateway-back/internal/stream"
)

// main is the entry point of the application.
//
// It performs the following steps:
//   - Loads the configuration from config.json.
//   - Initializes the SQLite database using sqlx.
//   - Initializes the StreamManager with the TCP receiver address.
//   - Initializes the camera repository and service.
//   - Restores previously saved camera streams from the database.
//   - Configures the HTTP handlers and routes with Gin.
//   - Starts the HTTP server on port 8080.
func main() {

	// Path to the configuration file.
	configPath := "config.json"

	// Load the configuration from the JSON file.
	cfg, err := config.LoadConfig(configPath)
	if err != nil {
		log.Fatalf("ERROR loading configuration: %v", err)
	}

	// Initialize SQLite with sqlx.
	db, err := database.InitDB("gateway.db")
	if err != nil {
		log.Fatalf("ERROR connecting to SQLite: %v", err)
	}
	defer db.Close()

	// Initialize the StreamManager with the TCP receiver address (Python/Server).
	streamMgr := stream.NewStreamManager(cfg.CloudAddress)

	// Initialize the repository and service for cameras.
	repo := camera.NewRepository(db)
	svc := camera.NewService(repo, streamMgr)

	// Restore cameras: reads the database and starts the RTSP connection for each one.
	ctx := context.Background()
	if err := svc.RestoreSavedStreams(ctx); err != nil {
		log.Printf("Error restoring saved cameras: %v", err)
	}

	// Configure the handler and HTTP server with Gin.
	handler := camera.NewHandler(svc)
	configHandler := config.NewConfigHandler(configPath, cfg, streamMgr)

	r := gin.Default()
	api := r.Group("/gateway/actions")

	handler.RegisterRoutes(api)
	configHandler.RegisterRoutes(api)

	// Start the HTTP server.
	log.Println("Gateway active at http://localhost:8080...")
	if err := r.Run(":8080"); err != nil {
		log.Fatalf("ERROR starting server: %v", err)
	}
}
