package api

import (
	"net/http"

	"stream-hub/internal/recording"

	"github.com/gin-gonic/gin"
)

// RecordingsHandler serves the incident media stored by the hub: the snapshots the
// ml-service sends and the clips the hub records.
type RecordingsHandler struct {
	recordings *recording.Manager
}

// NewRecordingsHandler creates a handler that serves files from the recordings manager.
func NewRecordingsHandler(recordings *recording.Manager) *RecordingsHandler {
	return &RecordingsHandler{recordings: recordings}
}

// RegisterRoutes registers the snapshot and clip routes.
func (r *RecordingsHandler) RegisterRoutes(router *gin.Engine) {
	g := router.Group("/stream-hub/recordings")
	g.GET("/snapshots/:name", r.Snapshot)
	g.GET("/clips/:name", r.Clip)
}

// Snapshot serves an incident image.
func (r *RecordingsHandler) Snapshot(c *gin.Context) {
	path, ok := r.recordings.SnapshotPath(c.Param("name"))
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	c.Header("Cache-Control", "max-age=86400")
	c.File(path)
}

// Clip serves an incident video. Range requests (seeking) are supported.
// A clip is written about post_roll_s after the person is back up, so a 404 shortly
// after an incident means "not saved yet".
func (r *RecordingsHandler) Clip(c *gin.Context) {
	path, ok := r.recordings.ClipPath(c.Param("name"))
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	c.Header("Cache-Control", "max-age=86400")
	c.File(path)
}
