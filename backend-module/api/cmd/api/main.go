// Package main is the FallGuard core backend API (Module 2).
//
// It is the only service the frontend talks to for data. It reads incidents, alerts,
// stats and ml-service's status from PostgreSQL, and manages cameras through
// gateway-back (keeping the database's cameras table in sync). Live video, incident
// snapshots and clips come from stream-hub, not from here.
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata" // CSV exports convert times to the browser's zone; Alpine has no zoneinfo

	"github.com/gin-gonic/gin"

	"backend-api/internal/api"
	"backend-api/internal/notify"
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
		Addr:        env("API_ADDR", ":8000"),
		DatabaseURL: env("DATABASE_URL", "postgresql://fallguard_admin:change-me@localhost:5433/fallguard?sslmode=disable"),
		Tenant:      env("TENANT", "demo-facility"),
		GatewayURL:  env("GATEWAY_URL", "http://localhost:8080"),
		// stream-hub's HTTP address (its config.json http_addr), not its TCP ingest port.
		StreamHubURL: env("STREAM_HUB_URL", "http://localhost:9000"),

		ServerHosting: strings.TrimSpace(os.Getenv("SERVER_HOSTING")), // shown in System status

		DefaultTimezone: env("DEFAULT_TIMEZONE", "America/Toronto"), // alert times when the organization has none

		// Accounts and notifications (see the root .env.example).
		AppURL:          os.Getenv("APP_URL"),
		AppSecret:       os.Getenv("APP_SECRET"),
		CookieSecure:    strings.EqualFold(os.Getenv("COOKIE_SECURE"), "true"),
		LinksInResponse: strings.EqualFold(os.Getenv("EMAIL_LINKS_IN_RESPONSE"), "true"),
		SMTP:            notify.EmailProvider{Type: "log"},

		// Anything but "false" keeps verification on, so a typo never switches it off.
		RequireEmailVerification: !strings.EqualFold(strings.TrimSpace(os.Getenv("REQUIRE_EMAIL_VERIFICATION")), "false"),

		// Phone cameras: the relay's public RTMPS address ("" = off) and where the gateway reads it.
		PhoneRelayURL: strings.TrimSpace(os.Getenv("PHONE_RELAY_URL")),
		RelayRTSPURL:  env("RELAY_RTSP_URL", "rtsp://test-camera:8554"),
		PhoneRTMPURL:  strings.TrimSpace(os.Getenv("PHONE_RTMP_URL")),
	}
	for _, e := range strings.Split(os.Getenv("SUPER_ADMIN_EMAILS"), ",") {
		if e = strings.ToLower(strings.TrimSpace(e)); e != "" {
			cfg.SuperAdmins = append(cfg.SuperAdmins, e)
		}
	}
	for _, o := range strings.Split(os.Getenv("ALLOWED_ORIGINS"), ",") {
		if o = strings.TrimSpace(o); o != "" {
			cfg.AllowedOrigins = append(cfg.AllowedOrigins, o)
		}
	}
	if host := os.Getenv("SMTP_HOST"); host != "" {
		port, _ := strconv.Atoi(os.Getenv("SMTP_PORT"))
		cfg.SMTP = notify.EmailProvider{Type: "smtp", Host: host, Port: port, Security: env("SMTP_SECURITY", "starttls"),
			Username: os.Getenv("SMTP_USERNAME"), FromEmail: os.Getenv("SMTP_FROM"), FromName: env("SMTP_FROM_NAME", "FallGuard")}
		cfg.SMTP.SetPassword(os.Getenv("SMTP_PASSWORD"))
	}

	db, err := store.Open(cfg.DatabaseURL, cfg.Tenant)
	if err != nil {
		log.Fatalf("database: %v", err)
	}
	defer db.Close()
	db.SetSuperAdmins(cfg.SuperAdmins)

	gin.SetMode(env("GIN_MODE", gin.ReleaseMode))
	r := gin.New()
	r.Use(gin.Recovery(), api.RequestLog())
	if err := db.Migrate(context.Background()); err != nil {
		log.Fatalf("database migration: %v", err)
	}
	server := api.New(cfg, db)
	server.Register(r)
	go server.WatchCameras(context.Background())        // camera status + "not working" log
	go server.RunNotifier(context.Background())         // email / SMS for alerts (Notifications page)
	go server.PurgeDeletedReports(context.Background()) // deleted reports past their retention
	go server.RunOrgMaintenance(context.Background())   // super admins in every org; erase deleted orgs after 30 days
	devMode := strings.ToLower(env("PROD_MODE", "true")) == "false"
	if devMode {
		go server.DevWebcam(context.Background())
	}

	srv := &http.Server{Addr: cfg.Addr, Handler: r, ReadHeaderTimeout: 10 * time.Second}
	log.Printf("backend API on %s (%s mode, tenant %s, gateway %s, stream-hub %s)", cfg.Addr,
		map[bool]string{true: "dev", false: "prod"}[devMode], cfg.Tenant, cfg.GatewayURL, cfg.StreamHubURL)
	if err := srv.ListenAndServe(); err != nil {
		log.Fatalf("server: %v", err)
	}
}
