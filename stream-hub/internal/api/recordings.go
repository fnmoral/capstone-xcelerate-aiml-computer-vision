package api

import (
	"net/http"
	"net/http/httputil"
	"net/url"
	"regexp"

	"github.com/gin-gonic/gin"
)

var (
	snapshotName = regexp.MustCompile(`^[\w.-]+\.jpg$`)
	clipName     = regexp.MustCompile(`^[\w.-]+\.mp4$`)
)

// RecordingsHandler proxies stored incident media (snapshots and clips),
// which are generated and kept by the ml-service.
type RecordingsHandler struct {
	proxy *httputil.ReverseProxy
}

// NewRecordingsHandler creates a handler that forwards to the ml-service at upstream.
func NewRecordingsHandler(upstream string) (*RecordingsHandler, error) {
	target, err := url.Parse(upstream)
	if err != nil {
		return nil, err
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, err error) {
		http.Error(w, "ml-service unavailable: "+err.Error(), http.StatusBadGateway)
	}
	return &RecordingsHandler{proxy: proxy}, nil
}

// RegisterRoutes registers the snapshot and clip routes under /api.
func (r *RecordingsHandler) RegisterRoutes(router *gin.Engine) {
	g := router.Group("/api")
	g.GET("/snapshots/:name", r.Snapshot)
	g.GET("/clips/:name", r.Clip)
}

// forward rewrites the request path and sends it to the ml-service.
func (r *RecordingsHandler) forward(c *gin.Context, path string) {
	c.Request.URL.Path = path
	c.Request.URL.RawPath = ""
	c.Request.URL.RawQuery = ""
	r.proxy.ServeHTTP(c.Writer, c.Request)
}

// Snapshot serves a detection snapshot image.
func (r *RecordingsHandler) Snapshot(c *gin.Context) {
	name := c.Param("name")
	if !snapshotName.MatchString(name) {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	c.Header("Cache-Control", "max-age=86400")
	r.forward(c, "/snapshots/"+name)
}

// Clip streams an incident video. Range requests (seeking) pass through.
func (r *RecordingsHandler) Clip(c *gin.Context) {
	name := c.Param("name")
	if !clipName.MatchString(name) {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	r.forward(c, "/clips/"+name)
}
