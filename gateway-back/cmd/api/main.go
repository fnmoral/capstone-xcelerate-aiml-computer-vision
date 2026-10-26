// Package main is the entry point for the gateway-back service.
//
// It loads the configuration, initializes the SQLite database, sets up the
// stream manager, restores previously saved camera streams, configures the
// HTTP handlers with Gin, and starts the HTTP server.
// package main
package main

import (
	"context"
	"embed"
	"io/fs"
	"log"
	"net/http"

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

//go:embed dist
var frontendFS embed.FS

func main() {
	configPath := "config.json"

	// Load configuration
	cfg, err := config.LoadConfig(configPath)
	if err != nil {
		log.Fatalf("ERROR loading configuration: %v", err)
	}

	// Initialize SQLite database
	db, err := database.InitDB("gateway.db")
	if err != nil {
		log.Fatalf("ERROR connecting to SQLite: %v", err)
	}
	defer db.Close()

	// Initialize StreamManager
	streamMgr := stream.NewStreamManager(cfg.StreamHubAddress)

	// Initialize camera repository and service
	repo := camera.NewRepository(db)
	svc := camera.NewService(repo, streamMgr)

	// Restore saved streams
	ctx := context.Background()
	if err := svc.RestoreSavedStreams(ctx); err != nil {
		log.Printf("Error restoring saved cameras: %v", err)
	}

	// Configure Gin router
	r := gin.Default()

	// API Routes Group
	api := r.Group("/gateway/actions")
	{
		handler := camera.NewHandler(svc, cfg)
		configHandler := config.NewConfigHandler(configPath, cfg, streamMgr)

		handler.RegisterRoutes(api)
		configHandler.RegisterRoutes(api)
	}

	// Embedded Frontend Static Files Serving
	// Extract the 'dist' subdirectory from the embedded filesystem
	subFS, err := fs.Sub(frontendFS, "dist")
	if err != nil {
		log.Fatalf("ERROR setting up embedded frontend filesystem: %v", err)
	}

	// Serve static assets (JS, CSS, images)
	r.StaticFS("/assets", http.FS(mustSub(subFS, "assets")))

	// Serve index.html for root and fallback to support SPA routing if needed
	r.GET("/", func(c *gin.Context) {
		indexHTML, err := fs.ReadFile(subFS, "index.html")
		if err != nil {
			c.String(http.StatusInternalServerError, "Frontend index.html not found")
			return
		}
		c.Data(http.StatusOK, "text/html; charset=utf-8", indexHTML)
	})

	// Optional: Handle SPA client-side routing fallback if routes change in React
	r.NoRoute(func(c *gin.Context) {
		indexHTML, err := fs.ReadFile(subFS, "index.html")
		if err != nil {
			c.Status(http.StatusNotFound)
			return
		}
		c.Data(http.StatusOK, "text/html; charset=utf-8", indexHTML)
	})

	// Start the HTTP server
	log.Println("Gateway active at http://localhost:8080...")
	if err := r.Run(":8080"); err != nil {
		log.Fatalf("ERROR starting server: %v", err)
	}
}

// Helper function to safely load subdirectories for embed.FS
func mustSub(fsys fs.FS, dir string) fs.FS {
	sub, err := fs.Sub(fsys, dir)
	if err != nil {
		panic(err)
	}
	return sub
}
