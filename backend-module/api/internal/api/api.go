// Package api implements the backend's HTTP routes (all under /api).
package api

import (
	"context"
	"errors"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"backend-api/internal/store"
)

// Config is the backend's runtime configuration (environment variables, see main.go).
type Config struct {
	Addr, DatabaseURL, Tenant, GatewayURL, MLURL, StreamHubURL string
}

// Server holds the dependencies of the routes.
type Server struct {
	cfg     Config
	db      *store.Store
	gateway gateway
	ml      ml
	hub     *httpClient
	mlProxy *httputil.ReverseProxy
}

// New creates the server.
func New(cfg Config, db *store.Store) *Server {
	mlURL, err := url.Parse(cfg.MLURL)
	if err != nil {
		log.Fatalf("ML_URL: %v", err)
	}
	proxy := httputil.NewSingleHostReverseProxy(mlURL)
	proxy.FlushInterval = -1 // stream MJPEG frames through immediately
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, err error) {
		http.Error(w, "ml-service unavailable: "+err.Error(), http.StatusBadGateway)
	}
	return &Server{
		cfg:     cfg,
		db:      db,
		gateway: gateway{newClient("gateway-back", cfg.GatewayURL, 8*time.Second)},
		ml:      ml{newClient("ml-service", cfg.MLURL, 3*time.Second)},
		hub:     newClient("stream-hub", cfg.StreamHubURL, 3*time.Second),
		mlProxy: proxy,
	}
}

// Register adds all routes.
func (s *Server) Register(r *gin.Engine) {
	a := r.Group("/api")
	a.GET("/health", s.health)

	a.GET("/cameras", s.listCameras)
	a.POST("/cameras", s.addCamera)
	a.PATCH("/cameras/:id", s.updateCamera)
	a.DELETE("/cameras/:id", s.deleteCamera)
	a.POST("/cameras/:id/pause", s.pauseResume("pause", "disabled"))
	a.POST("/cameras/:id/resume", s.pauseResume("resume", "online"))
	a.GET("/cameras/:id/stream", s.proxyML(func(id string) string { return "/stream/" + url.PathEscape(id) }))
	a.GET("/cameras/:id/frame.jpg", s.proxyML(func(id string) string { return "/frame/" + url.PathEscape(id) + ".jpg" }))
	a.GET("/zones", s.listZones)

	a.GET("/incidents", s.listIncidents)
	a.GET("/incidents/:id", s.getIncident)
	a.PATCH("/incidents/:id", s.updateIncident)
	a.GET("/alerts", s.listAlerts)
	a.POST("/alerts/:id/acknowledge", s.alertStatus("acknowledged"))
	a.POST("/alerts/:id/resolve", s.alertStatus("resolved"))
	a.POST("/alerts/:id/false-positive", s.alertStatus("false_positive"))

	a.GET("/stats", s.stats)
	a.GET("/snapshots/:name", s.snapshot)
	a.GET("/detection", s.detection)
	a.GET("/gateway/config", s.gatewayConfig)
	a.PUT("/gateway/config", s.gatewayConfig)
}

// ---------- helpers ----------

func fail(c *gin.Context, err error) {
	var up *upstreamError
	switch {
	case errors.Is(err, store.ErrNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
	case errors.Is(err, store.ErrNameTaken):
		c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
	case errors.As(err, &up):
		status := up.Status
		if status < 400 || status >= 500 {
			status = http.StatusBadGateway
		}
		c.JSON(status, gin.H{"error": up.Body, "service": up.Service})
	case strings.Contains(err.Error(), "unreachable"):
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
	default:
		log.Printf("%s %s: %v", c.Request.Method, c.Request.URL.Path, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
	}
}

// RequestLog logs API calls except the frequent polling and video routes.
func RequestLog() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()
		p := c.Request.URL.Path
		if c.Request.Method == http.MethodGet && (strings.HasSuffix(p, "/stream") || strings.HasSuffix(p, "/frame.jpg") ||
			p == "/api/cameras" || p == "/api/stats" || p == "/api/health" || p == "/api/alerts" ||
			strings.HasPrefix(p, "/api/snapshots/") || p == "/api/incidents") && c.Writer.Status() < 400 {
			return
		}
		log.Printf("%s %s %d %s", c.Request.Method, p, c.Writer.Status(), time.Since(start).Round(time.Millisecond))
	}
}

// ---------- health ----------

func (s *Server) health(c *gin.Context) {
	ctx, cancel := context.WithTimeout(c.Request.Context(), 3*time.Second)
	defer cancel()
	type check struct {
		OK      bool   `json:"ok"`
		Latency int64  `json:"latency_ms"`
		Error   string `json:"error,omitempty"`
	}
	checks := map[string]func(context.Context) error{
		"database":     s.db.Ping,
		"gateway-back": func(ctx context.Context) error { return s.gateway.do(ctx, http.MethodGet, "/gateway/actions/health", nil, nil) },
		"ml-service":   func(ctx context.Context) error { return s.ml.do(ctx, http.MethodGet, "/api/config", nil, nil) },
		"stream-hub":   func(ctx context.Context) error { return s.hub.do(ctx, http.MethodGet, "/health", nil, nil) },
	}
	out := map[string]check{}
	var mu sync.Mutex
	var wg sync.WaitGroup
	for name, fn := range checks {
		wg.Add(1)
		go func(name string, fn func(context.Context) error) {
			defer wg.Done()
			t := time.Now()
			err := fn(ctx)
			r := check{OK: err == nil, Latency: time.Since(t).Milliseconds()}
			if err != nil {
				r.Error = err.Error()
			}
			mu.Lock()
			out[name] = r
			mu.Unlock()
		}(name, fn)
	}
	wg.Wait()
	all := true
	for _, r := range out {
		all = all && r.OK
	}
	c.JSON(http.StatusOK, gin.H{"ok": all, "services": out, "tenant": s.cfg.Tenant})
}

// ---------- cameras ----------

// CameraView is a camera as the frontend sees it: gateway state + database details + live ML state.
type CameraView struct {
	ID              string           `json:"id"`
	Name            string           `json:"name"`
	Location        *string          `json:"location"`
	Zone            *string          `json:"zone"`
	Status          string           `json:"status"` // online | paused | not_on_gateway
	OnGateway       bool             `json:"on_gateway"`
	RTSPURL         string           `json:"rtsp_url"`
	CreatedAt       time.Time        `json:"created_at"`
	Live            bool             `json:"live"` // ml-service is receiving its video
	People          []map[string]any `json:"people"`
	LastFrameAgeS   *float64         `json:"last_frame_age_s"`
	ActiveIncidents int              `json:"active_incidents"`
}

func (s *Server) listCameras(c *gin.Context) {
	ctx := c.Request.Context()
	gw, gwErr := s.gateway.cameras(ctx)
	dbCams, err := s.db.Cameras(ctx)
	if err != nil {
		fail(c, err)
		return
	}
	byID := map[string]store.Camera{}
	for _, d := range dbCams {
		byID[d.ID] = d
	}
	// Cameras added directly in the gateway UI get registered here, so incidents can show
	// their name, location and zone.
	if gwErr == nil {
		synced := false
		for _, g := range gw {
			if _, ok := byID[g.ID]; !ok {
				if err := s.db.UpsertCamera(ctx, g.ID, g.Name, g.RTSPURL, dbStatus(g.Status), nil, nil); err != nil {
					log.Printf("registering gateway camera %s: %v", g.ID, err)
				}
				synced = true
			}
		}
		if synced {
			if dbCams, err = s.db.Cameras(ctx); err == nil {
				for _, d := range dbCams {
					byID[d.ID] = d
				}
			}
		}
	}

	live, _ := s.ml.state(ctx) // empty if ml-service is down
	active := map[string]int{}
	if list, err := s.db.Incidents(ctx, store.IncidentFilter{Status: "active", Limit: 500}); err == nil {
		for _, i := range list {
			for _, cam := range i.Cameras {
				active[cam.CameraID]++
			}
			if len(i.Cameras) == 0 {
				active[i.CameraID]++
			}
		}
	}

	out := []CameraView{}
	seen := map[string]bool{}
	for _, g := range gw {
		v := CameraView{ID: g.ID, Name: g.Name, Status: g.Status, OnGateway: true,
			RTSPURL: store.SafeURL(g.RTSPURL), CreatedAt: g.CreatedAt, People: []map[string]any{}}
		if d, ok := byID[g.ID]; ok {
			v.Name, v.Location, v.Zone = d.Name, d.Location, d.Zone
		}
		s.addLive(&v, live, active)
		out = append(out, v)
		seen[g.ID] = true
	}
	for _, d := range dbCams {
		if seen[d.ID] {
			continue
		}
		v := CameraView{ID: d.ID, Name: d.Name, Location: d.Location, Zone: d.Zone, Status: "not_on_gateway",
			CreatedAt: d.CreatedAt, People: []map[string]any{}}
		s.addLive(&v, live, active)
		out = append(out, v)
	}
	resp := gin.H{"cameras": out}
	if gwErr != nil {
		resp["gateway_error"] = gwErr.Error()
	}
	c.JSON(http.StatusOK, resp)
}

func (s *Server) addLive(v *CameraView, live map[string]MLCamera, active map[string]int) {
	if l, ok := live[v.ID]; ok {
		v.Live = l.LastFrameAgeS != nil && *l.LastFrameAgeS < 10
		v.LastFrameAgeS = l.LastFrameAgeS
		if l.People != nil {
			v.People = l.People
		}
	}
	v.ActiveIncidents = active[v.ID]
}

func dbStatus(gatewayStatus string) string {
	if gatewayStatus == "paused" {
		return "disabled"
	}
	return "online"
}

type cameraInput struct {
	Name     *string `json:"name"`
	RTSPURL  string  `json:"rtsp_url"`
	Username string  `json:"username"`
	Password string  `json:"password"`
	Location *string `json:"location"`
	Zone     *string `json:"zone"`
}

var rtspURL = regexp.MustCompile(`^rtsps?://\S+$`)

func (s *Server) addCamera(c *gin.Context) {
	var in cameraInput
	if err := c.ShouldBindJSON(&in); err != nil || in.Name == nil || strings.TrimSpace(*in.Name) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "name and rtsp_url are required"})
		return
	}
	if !rtspURL.MatchString(in.RTSPURL) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "rtsp_url must start with rtsp:// or rtsps://"})
		return
	}
	name := strings.TrimSpace(*in.Name)
	ctx := c.Request.Context()
	cam, err := s.gateway.addCamera(ctx, name, in.RTSPURL, in.Username, in.Password)
	if err != nil {
		fail(c, err)
		return
	}
	if err := s.db.UpsertCamera(ctx, cam.ID, name, in.RTSPURL, "online", trimmed(in.Location), trimmed(in.Zone)); err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"id": cam.ID})
}

func (s *Server) updateCamera(c *gin.Context) {
	var in cameraInput
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid JSON"})
		return
	}
	if err := s.db.UpdateCamera(c.Request.Context(), c.Param("id"), trimmed(in.Name), trimmed(in.Location), trimmed(in.Zone)); err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (s *Server) deleteCamera(c *gin.Context) {
	ctx := c.Request.Context()
	id := c.Param("id")
	if err := s.gateway.deleteCamera(ctx, id); err != nil {
		var up *upstreamError
		if !(errors.As(err, &up) && up.Status < 500) { // gone from the gateway already: still remove the row
			fail(c, err)
			return
		}
	}
	if err := s.db.DeleteCamera(ctx, id); err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (s *Server) pauseResume(action, status string) gin.HandlerFunc {
	return func(c *gin.Context) {
		ctx := c.Request.Context()
		cam, err := s.gateway.camera(ctx, action, c.Param("id"))
		if err != nil {
			fail(c, err)
			return
		}
		if err := s.db.SetCameraStatus(ctx, cam.ID, status); err != nil {
			fail(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"id": cam.ID, "status": cam.Status})
	}
}

func (s *Server) listZones(c *gin.Context) {
	zones, err := s.db.Zones(c.Request.Context())
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"zones": zones})
}

func trimmed(p *string) *string {
	if p == nil {
		return nil
	}
	t := strings.TrimSpace(*p)
	return &t
}

// ---------- incidents and alerts ----------

func (s *Server) listIncidents(c *gin.Context) {
	f := store.IncidentFilter{Status: c.Query("status"), CameraID: c.Query("camera_id")}
	f.Limit, _ = strconv.Atoi(c.DefaultQuery("limit", "100"))
	if since := c.Query("since"); since != "" {
		t, err := time.Parse(time.RFC3339, since)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "since must be RFC 3339"})
			return
		}
		f.Since = &t
	}
	list, err := s.db.Incidents(c.Request.Context(), f)
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"incidents": list})
}

func (s *Server) getIncident(c *gin.Context) {
	inc, preds, err := s.db.Incident(c.Request.Context(), c.Param("id"))
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"incident": inc, "predictions": preds})
}

var incidentStatuses = map[string]bool{"active": true, "recovered": true, "unresolved": true, "false_positive": true}

func (s *Server) updateIncident(c *gin.Context) {
	var in struct {
		Status *string `json:"status"`
		Notes  *string `json:"notes"`
	}
	if err := c.ShouldBindJSON(&in); err != nil || (in.Status != nil && !incidentStatuses[*in.Status]) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "status must be active, recovered, unresolved or false_positive"})
		return
	}
	if err := s.db.UpdateIncident(c.Request.Context(), c.Param("id"), in.Status, in.Notes); err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (s *Server) listAlerts(c *gin.Context) {
	list, err := s.db.Alerts(c.Request.Context(), c.Query("status"))
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"alerts": list})
}

func (s *Server) alertStatus(status string) gin.HandlerFunc {
	return func(c *gin.Context) {
		a, err := s.db.SetAlertStatus(c.Request.Context(), c.Param("id"), status)
		if err != nil {
			fail(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"alert": a})
	}
}

func (s *Server) stats(c *gin.Context) {
	st, err := s.db.Stats(c.Request.Context())
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, st)
}

// ---------- pass-through to ml-service and gateway-back ----------

var snapshotName = regexp.MustCompile(`^[\w.-]+\.jpg$`)

func (s *Server) proxyML(path func(id string) string) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Request.URL.Path = path(c.Param("id"))
		c.Request.URL.RawPath = ""
		c.Request.URL.RawQuery = ""
		s.mlProxy.ServeHTTP(c.Writer, c.Request)
	}
}

func (s *Server) snapshot(c *gin.Context) {
	name := c.Param("name")
	if !snapshotName.MatchString(name) {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	c.Request.URL.Path = "/snapshots/" + name
	c.Request.URL.RawQuery = ""
	c.Header("Cache-Control", "max-age=86400")
	s.mlProxy.ServeHTTP(c.Writer, c.Request)
}

func (s *Server) detection(c *gin.Context) {
	var out map[string]any
	if err := s.ml.do(c.Request.Context(), http.MethodGet, "/api/config", nil, &out); err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, out)
}

func (s *Server) gatewayConfig(c *gin.Context) {
	var body any
	if c.Request.Method == http.MethodPut {
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid JSON"})
			return
		}
	}
	var out any
	if err := s.gateway.do(c.Request.Context(), c.Request.Method, "/gateway/actions/config", body, &out); err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, out)
}
