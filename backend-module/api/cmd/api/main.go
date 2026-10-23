// Package main is the FallGuard core backend API (Module 2).
//
// It is the only service the frontend talks to. It reads incidents, alerts and stats
// from PostgreSQL, manages cameras through gateway-back (keeping the database's cameras
// table in sync), and passes through the live annotated video, photos and detection
// settings from ml-service.
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
	_ "time/tzdata" // CSV exports convert times to the browser's zone; Alpine has no zoneinfo

	"github.com/gin-gonic/gin"

	"backend-api/internal/api"
	"backend-api/internal/store"
)

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func main() {
	cfg := api.Config{
		Addr:         env("API_ADDR", ":8000"),
		DatabaseURL:  env("DATABASE_URL", "postgresql://fallguard_admin@localhost:5432/fallguard"),
		Tenant:       env("TENANT", "demo-facility"),
		GatewayURL:   env("GATEWAY_URL", "http://localhost:8080"),
		MLURL:        env("ML_URL", "http://localhost:8000"),
		StreamHubURL: env("STREAM_HUB_URL", "http://localhost:9000"),
	}

	db, err := store.Open(cfg.DatabaseURL, cfg.Tenant)
	if err != nil {
		log.Fatalf("database: %v", err)
	}
	defer db.Close()

	gin.SetMode(env("GIN_MODE", gin.ReleaseMode))
	r := gin.New()
	r.Use(gin.Recovery(), api.RequestLog())
	if err := db.Migrate(context.Background()); err != nil {
		log.Fatalf("database migration: %v", err)
	}
	server := api.New(cfg, db)
	server.Register(r)
	go server.WatchCameras(context.Background()) // camera status + "not working" log
	devMode := strings.ToLower(env("PROD_MODE", "true")) == "false"
	if devMode {
		go server.DevWebcam(context.Background())
	}

	srv := &http.Server{Addr: cfg.Addr, Handler: r, ReadHeaderTimeout: 10 * time.Second}
	log.Printf("backend API on %s (%s mode, tenant %s, gateway %s, ml %s)", cfg.Addr,
		map[bool]string{true: "dev", false: "prod"}[devMode], cfg.Tenant, cfg.GatewayURL, cfg.MLURL)
	if err := srv.ListenAndServe(); err != nil {
		log.Fatalf("server: %v", err)
	}
}
