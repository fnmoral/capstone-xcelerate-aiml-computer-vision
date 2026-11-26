package api

import (
	"net/http"
	"os"

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
	// Disk used by clips, for the API's system status (not under /stream-hub: nginx doesn't serve it).
	router.GET("/recordings-usage", func(c *gin.Context) { c.JSON(http.StatusOK, r.recordings.Usage()) })
	// The API deletes a fall event's media when the event is deleted permanently (not under
	// /stream-hub either: browsers can't reach it).
	router.DELETE("/recordings/:kind/:name", r.Delete)
}

// Delete removes a clip or snapshot (kind "clips" or "snapshots"). Already gone = OK.
func (r *RecordingsHandler) Delete(c *gin.Context) {
	var path string
	var ok bool
	switch c.Param("kind") {
	case "clips":
		path, ok = r.recordings.ClipPath(c.Param("name"))
	case "snapshots":
		path, ok = r.recordings.SnapshotPath(c.Param("name"))
	default:
		c.JSON(http.StatusBadRequest, gin.H{"error": "kind must be clips or snapshots"})
		return
	}
	if ok {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// Snapshot serves an incident image.
func (r *RecordingsHandler) Snapshot(c *gin.Context) {
	path, ok := r.recordings.SnapshotPath(c.Param("name"))
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	c.Header("Cache-Control", "no-cache") // revalidate (cheap 304): a file can be replaced, e.g. a repaired clip
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
	c.Header("Cache-Control", "no-cache") // revalidate (cheap 304): a file can be replaced, e.g. a repaired clip
	c.File(path)
}
