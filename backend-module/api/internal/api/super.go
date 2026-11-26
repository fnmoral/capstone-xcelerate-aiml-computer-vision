package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"backend-api/internal/store"
)

// Super admins (SUPER_ADMIN_EMAILS) run the platform: admins of every organization (added
// automatically), they can create, delete and restore organizations and change each
// organization's fall-detection and alert rules.

// isSuper reports whether the email is a super admin's.
func (s *Server) isSuper(email string) bool {
	email = strings.ToLower(strings.TrimSpace(email))
	for _, e := range s.cfg.SuperAdmins {
		if e == email {
			return true
		}
	}
	return false
}

// superOnly lets only super admins through.
func (s *Server) superOnly(c *gin.Context) {
	if se := session(c); se == nil || !se.User.SuperAdmin {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "only a FallGuard super admin can do this", "code": "forbidden"})
		return
	}
	c.Next()
}

// syncSupers makes the super admins admins of every organization.
func (s *Server) syncSupers(ctx context.Context) {
	if n, err := s.db.EnsureSuperMemberships(ctx); err != nil {
		log.Printf("super admins: %v", err)
	} else if n > 0 {
		log.Printf("super admins: added to %d organization(s)", n)
	}
}

// RunOrgMaintenance keeps the super admins in every organization and erases organizations
// deleted more than 30 days ago, at start-up and then every hour.
func (s *Server) RunOrgMaintenance(ctx context.Context) {
	t := time.NewTicker(time.Hour)
	defer t.Stop()
	for {
		s.syncSupers(ctx)
		if n, err := s.db.PurgeDeletedOrgs(ctx); err != nil {
			log.Printf("deleted organizations: %v", err)
		} else if n > 0 {
			log.Printf("deleted organizations: erased %d past their 30 days", n)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// ---------- organizations (super admins) ----------

func (s *Server) listAllOrgs(c *gin.Context) {
	orgs, err := s.db.AllOrgs(c.Request.Context())
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"orgs": orgs, "current": session(c).TenantID})
}

func (s *Server) createOrgSuper(c *gin.Context) {
	var in struct {
		Name string `json:"name"`
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		badRequest(c, "invalid JSON")
		return
	}
	name := strings.TrimSpace(in.Name)
	if name == "" || len(name) > 100 {
		badRequest(c, "the organization needs a name (at most 100 characters)")
		return
	}
	se := session(c)
	id, err := s.db.CreateOrg(c.Request.Context(), name, se.User.ID, se.User.DisplayName())
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"id": id})
}

func (s *Server) deleteOrgSuper(c *gin.Context) {
	se, id := session(c), c.Param("id")
	if id == se.TenantID {
		c.JSON(http.StatusConflict, gin.H{"error": "you're in this organization: open another one first"})
		return
	}
	err := s.db.DeleteOrg(c.Request.Context(), id, se.User.ID, se.User.DisplayName())
	if errors.Is(err, store.ErrHomeOrg) {
		c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
		return
	}
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (s *Server) restoreOrgSuper(c *gin.Context) {
	se := session(c)
	err := s.db.RestoreOrg(c.Request.Context(), c.Param("id"), se.User.ID, se.User.DisplayName())
	if errors.Is(err, store.ErrOrgNotDeleted) {
		c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
		return
	}
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// platformActivity: what super admins did to organizations and fall events (kept even after
// an organization is erased).
func (s *Server) platformActivity(c *gin.Context) {
	list, err := s.db.PlatformLog(c.Request.Context(), 300)
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"entries": list})
}

// ---------- detection and alert rules (per organization) ----------

// ruleField is one rule a super admin can change: its allowed range, and the detector's
// built-in default (used when ml-service hasn't reported config.yaml's values yet).
type ruleField struct {
	Key      string  `json:"key"`
	Group    string  `json:"group"` // fall | alerts | advanced
	Min      float64 `json:"min"`
	Max      float64 `json:"max"`
	Step     float64 `json:"step"`
	Integer  bool    `json:"integer,omitempty"`
	Fallback float64 `json:"-"`
}

var ruleFields = []ruleField{
	{Key: "confirm_seconds", Group: "fall", Min: 1, Max: 30, Step: 0.5, Fallback: 3},
	{Key: "recover_seconds", Group: "fall", Min: 1, Max: 60, Step: 0.5, Fallback: 3},
	{Key: "lying_torso_angle_deg", Group: "fall", Min: 30, Max: 85, Step: 1, Fallback: 60},
	{Key: "falling_torso_angle_deg", Group: "fall", Min: 10, Max: 80, Step: 1, Fallback: 35},
	{Key: "lying_aspect_ratio", Group: "fall", Min: 0.8, Max: 3, Step: 0.05, Fallback: 1.3},
	{Key: "fall_velocity", Group: "fall", Min: 0.3, Max: 5, Step: 0.1, Fallback: 1.2},
	{Key: "high_after_seconds", Group: "alerts", Min: 10, Max: 3600, Step: 5, Integer: true, Fallback: 60},
	{Key: "critical_after_seconds", Group: "alerts", Min: 30, Max: 7200, Step: 10, Integer: true, Fallback: 300},
	{Key: "lost_track_seconds", Group: "alerts", Min: 3, Max: 120, Step: 1, Fallback: 10},
	{Key: "confirm_ratio", Group: "advanced", Min: 0.5, Max: 1, Step: 0.05, Fallback: 0.8},
	{Key: "standing_legs", Group: "advanced", Min: 0.3, Max: 0.95, Step: 0.05, Fallback: 0.6},
	{Key: "min_visible_keypoints", Group: "advanced", Min: 3, Max: 17, Step: 1, Integer: true, Fallback: 6},
	{Key: "min_keypoint_conf", Group: "advanced", Min: 0.1, Max: 0.9, Step: 0.05, Fallback: 0.3},
	{Key: "handoff_seconds", Group: "advanced", Min: 0, Max: 15, Step: 0.5, Fallback: 5},
	{Key: "handoff_radius", Group: "advanced", Min: 0.2, Max: 3, Step: 0.05, Fallback: 0.75},
	{Key: "handoff_incident_radius", Group: "advanced", Min: 0.2, Max: 4, Step: 0.05, Fallback: 1.25},
}

// ruleDefaults are the detector's defaults (config.yaml), from ml-service's status when it
// has reported them, else the built-in fallbacks.
func (s *Server) ruleDefaults(ctx context.Context) map[string]float64 {
	out := map[string]float64{}
	for _, f := range ruleFields {
		out[f.Key] = f.Fallback
	}
	if st, err := s.db.MLStatus(ctx); err == nil && st != nil {
		var payload struct {
			RuleDefaults map[string]float64 `json:"rule_defaults"`
		}
		if json.Unmarshal(st.Payload, &payload) == nil {
			for k, v := range payload.RuleDefaults {
				if _, ok := out[k]; ok {
					out[k] = v
				}
			}
		}
	}
	return out
}

// rulesView: the fields, the defaults, this organization's saved changes, and whether the
// viewer may change them (super admins only).
func (s *Server) rulesView(c *gin.Context) {
	ctx := c.Request.Context()
	saved, err := s.db.FallRules(ctx)
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"fields": ruleFields, "defaults": s.ruleDefaults(ctx), "saved": saved,
		"can_edit": session(c).User.SuperAdmin})
}

// saveRules replaces this organization's rule changes ({"rules": {}} restores the defaults).
// A value equal to the default isn't stored, so it follows the default if that changes.
func (s *Server) saveRules(c *gin.Context) {
	var in struct {
		Rules map[string]float64 `json:"rules"`
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		badRequest(c, "invalid JSON")
		return
	}
	defaults := s.ruleDefaults(c.Request.Context())
	byKey := map[string]ruleField{}
	for _, f := range ruleFields {
		byKey[f.Key] = f
	}
	keep := map[string]float64{}
	for k, v := range in.Rules {
		f, ok := byKey[k]
		if !ok {
			badRequest(c, "unknown rule: "+k)
			return
		}
		if math.IsNaN(v) || v < f.Min || v > f.Max || (f.Integer && v != math.Trunc(v)) {
			badRequest(c, fmt.Sprintf("%s must be between %g and %g", k, f.Min, f.Max))
			return
		}
		if v != defaults[k] {
			keep[k] = v
		}
	}
	value := func(k string) float64 {
		if v, ok := keep[k]; ok {
			return v
		}
		return defaults[k]
	}
	if value("critical_after_seconds") <= value("high_after_seconds") {
		badRequest(c, "Critical must come after High")
		return
	}
	if value("falling_torso_angle_deg") >= value("lying_torso_angle_deg") {
		badRequest(c, "the falling angle must be smaller than the lying angle")
		return
	}
	if err := s.db.SetFallRules(c.Request.Context(), keep, actor(c)); err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"saved": keep})
}
