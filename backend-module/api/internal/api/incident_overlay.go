package api

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// incidentOverlayKeys are the overlays drawn on incident videos (the frontend's LiveOverlay).
var incidentOverlayKeys = map[string]bool{
	"boxes": true, "label": true, "track": true, "confidence": true,
	"center": true, "skeleton": true, "keypoints": true, "grid": true,
}

// saveIncidentOverlay: {"boxes": true, "label": true, ...}, the organization's default overlays
// on incident videos (everyone can still change them on the page).
func (s *Server) saveIncidentOverlay(c *gin.Context) {
	var in map[string]bool
	if err := c.ShouldBindJSON(&in); err != nil || len(in) == 0 {
		badRequest(c, "send the overlays as {name: true|false}")
		return
	}
	for k := range in {
		if !incidentOverlayKeys[k] {
			badRequest(c, "unknown overlay "+k)
			return
		}
	}
	if err := s.db.SetIncidentOverlay(c.Request.Context(), in, actor(c)); err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"incident_overlay": in})
}
