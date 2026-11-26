package api

import (
	"context"
	"errors"
	"log"
	"net/http"
	"net/url"

	"github.com/gin-gonic/gin"

	"backend-api/internal/store"
)

// Fall event bin (super admins): delete a fall event to the bin (hidden everywhere, kept)
// or permanently (every record and its media gone); restore from the bin on Manage
// organizations.

// deleteIncident: ?mode=bin moves the fall event to the bin; ?mode=forever deletes it and
// everything about it.
func (s *Server) deleteIncident(c *gin.Context) {
	ctx, id := c.Request.Context(), c.Param("id")
	switch c.Query("mode") {
	case "bin":
		if !s.incidentErr(c, s.db.BinIncident(ctx, id, actor(c))) {
			c.JSON(http.StatusOK, gin.H{"ok": true})
		}
	case "forever":
		// Only a fall event of the organization you're in (Incident is per organization).
		if _, _, err := s.db.Incident(ctx, id); err != nil {
			fail(c, err)
			return
		}
		s.deleteForever(c, id)
	default:
		badRequest(c, "mode must be bin or forever")
	}
}

func (s *Server) incidentBin(c *gin.Context) {
	list, err := s.db.BinnedIncidents(c.Request.Context())
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"incidents": list})
}

func (s *Server) restoreBinned(c *gin.Context) {
	if !s.incidentErr(c, s.db.RestoreIncident(c.Request.Context(), c.Param("id"), actor(c))) {
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

func (s *Server) deleteBinned(c *gin.Context) {
	s.deleteForever(c, c.Param("id"))
}

// deleteForever removes the fall event's records, then its clips and snapshots on stream-hub
// (a file that can't be deleted now is logged; stream-hub's retention removes it later).
func (s *Server) deleteForever(c *gin.Context, id string) {
	clips, snaps, err := s.db.DeleteIncidentForever(c.Request.Context(), id, actor(c))
	if s.incidentErr(c, err) {
		return
	}
	ctx := context.WithoutCancel(c.Request.Context())
	for kind, names := range map[string][]string{"clips": clips, "snapshots": snaps} {
		for _, name := range names {
			if err := s.hub.do(ctx, http.MethodDelete, "/recordings/"+kind+"/"+url.PathEscape(name), nil, nil); err != nil {
				log.Printf("deleting %s %s of fall event %s: %v", kind, name, id, err)
			}
		}
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "clips": len(clips), "snapshots": len(snaps)})
}

// incidentErr answers an error of the bin actions; true = answered.
func (s *Server) incidentErr(c *gin.Context, err error) bool {
	switch {
	case err == nil:
		return false
	case errors.Is(err, store.ErrIncidentActive):
		c.JSON(http.StatusConflict, gin.H{"error": err.Error(), "code": "incident_active"})
	default:
		fail(c, err)
	}
	return true
}
