package api

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"backend-api/internal/store"
)

// reportForms are the incident report forms the app can fill in.
var reportForms = map[string]string{
	"wsib_form7":  "WSIB Form 7: Employer's Report of Injury/Illness (Ontario)",
	"ohsa_notice": "OHSA s.51/52 written notice to the Ministry of Labour (Ontario)",
	"osha_301":    "OSHA Form 301: Injury and Illness Incident Report (US)",
	"internal":    "Internal incident investigation report",
}

// reportFacts is everything FallGuard knows about an incident, for filling in a report:
// the incident, cameras, alert handling timeline, notes, the organization's profile and
// the person preparing the report.
func (s *Server) reportFacts(c *gin.Context) {
	ctx := c.Request.Context()
	inc, preds, err := s.db.Incident(ctx, c.Param("id"))
	if err != nil {
		fail(c, err)
		return
	}
	activity, err := s.db.Logs(ctx, store.LogFilter{IncidentID: inc.ID, Limit: 500})
	if err != nil {
		fail(c, err)
		return
	}
	org, err := s.db.Org(ctx)
	if err != nil {
		fail(c, err)
		return
	}
	settings, err := s.db.Settings(ctx)
	if err != nil {
		fail(c, err)
		return
	}
	cams, err := s.db.Cameras(ctx)
	if err != nil {
		fail(c, err)
		return
	}
	byID := map[string]store.Camera{}
	for _, cam := range cams {
		byID[cam.ID] = cam
	}
	type camFact struct {
		ID       string  `json:"id"`
		Name     *string `json:"name"`
		Location *string `json:"location"`
		Zone     *string `json:"zone"`
		Snapshot *string `json:"snapshot_key"`
		Clip     *string `json:"clip_key"`
	}
	cameras := []camFact{}
	seen := map[string]bool{}
	add := func(id string, name, snap, clip *string) {
		if seen[id] {
			return
		}
		seen[id] = true
		f := camFact{ID: id, Name: name, Snapshot: snap, Clip: clip}
		if cam, ok := byID[id]; ok {
			f.Name, f.Location, f.Zone = &cam.Name, cam.Location, cam.Zone
		}
		cameras = append(cameras, f)
	}
	add(inc.CameraID, inc.CameraName, inc.SnapshotKey, inc.ClipKey)
	for _, ic := range inc.Cameras {
		add(ic.CameraID, ic.CameraName, ic.SnapshotKey, ic.ClipKey)
	}
	// Model in use, from ml-service's status (best effort).
	var model *string
	if st, err := s.db.MLStatus(ctx); err == nil && st != nil {
		var p map[string]any
		if json.Unmarshal(st.Payload, &p) == nil {
			for _, k := range []string{"model_in_use", "model"} {
				if m, ok := p[k].(string); ok && m != "" {
					model = &m
					break
				}
			}
		}
	}
	se := session(c)
	c.JSON(http.StatusOK, gin.H{
		"incident":         inc,
		"cameras":          cameras,
		"activity":         activity,
		"prediction_count": len(preds),
		"model":            model,
		"org":              org,
		"timezone":         settings.Timezone,
		"prepared_by":      gin.H{"name": se.User.DisplayName(), "email": se.User.Email, "phone": se.User.Phone, "role": se.Role},
		"generated_at":     time.Now(),
		"app_url":          s.appURL(c),
	})
}

func (s *Server) listIncidentReports(c *gin.Context) {
	list, err := s.db.IncidentReports(c.Request.Context(), c.Param("id"))
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"reports": list, "forms": reportForms})
}

func (s *Server) getIncidentReport(c *gin.Context) {
	r, err := s.db.IncidentReport(c.Request.Context(), c.Param("id"))
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"report": r})
}

type reportInput struct {
	Form    string          `json:"form"`
	Title   string          `json:"title"`
	Status  string          `json:"status"`
	Content json.RawMessage `json:"content"`
}

func (in *reportInput) check(c *gin.Context, creating bool) bool {
	if creating {
		if _, ok := reportForms[in.Form]; !ok {
			badRequest(c, "form must be wsib_form7, ohsa_notice, osha_301 or internal")
			return false
		}
	}
	in.Title = strings.TrimSpace(in.Title)
	if in.Title == "" {
		in.Title = reportForms[in.Form]
	}
	if len(in.Title) > 200 {
		badRequest(c, "title must be at most 200 characters")
		return false
	}
	if in.Status == "" {
		in.Status = "draft"
	}
	if in.Status != "draft" && in.Status != "final" {
		badRequest(c, "status must be draft or final")
		return false
	}
	if len(in.Content) == 0 {
		in.Content = json.RawMessage(`{}`)
	}
	var obj map[string]any
	if len(in.Content) > 256*1024 || json.Unmarshal(in.Content, &obj) != nil {
		badRequest(c, "content must be a JSON object of at most 256 KB")
		return false
	}
	return true
}

func (s *Server) createIncidentReport(c *gin.Context) {
	var in reportInput
	if err := c.ShouldBindJSON(&in); err != nil {
		badRequest(c, "invalid JSON")
		return
	}
	if !in.check(c, true) {
		return
	}
	r, err := s.db.CreateIncidentReport(c.Request.Context(), c.Param("id"), in.Form, in.Title, in.Content, actor(c))
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"report": r})
}

func (s *Server) updateIncidentReport(c *gin.Context) {
	var in reportInput
	if err := c.ShouldBindJSON(&in); err != nil {
		badRequest(c, "invalid JSON")
		return
	}
	if !in.check(c, false) {
		return
	}
	r, err := s.db.UpdateIncidentReport(c.Request.Context(), c.Param("id"), in.Title, in.Status, in.Content, actor(c))
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"report": r})
}

// deleteIncidentReport moves the report to Recently deleted (restorable for the
// organization's report_retention_days).
func (s *Server) deleteIncidentReport(c *gin.Context) {
	ctx := c.Request.Context()
	if err := s.db.DeleteIncidentReport(ctx, c.Param("id"), actor(c)); err != nil {
		fail(c, err)
		return
	}
	days := store.DefaultReportRetentionDays
	if org, err := s.db.Org(ctx); err == nil {
		days = org.ReportRetentionDays
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "restorable_days": days})
}

func (s *Server) listDeletedIncidentReports(c *gin.Context) {
	list, err := s.db.DeletedIncidentReports(c.Request.Context())
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"reports": list})
}

func (s *Server) restoreIncidentReport(c *gin.Context) {
	r, err := s.db.RestoreIncidentReport(c.Request.Context(), c.Param("id"), actor(c))
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"report": r})
}

// PurgeDeletedReports removes deleted reports once their organization's retention has
// passed, at start-up and then every hour. Runs until ctx is cancelled.
func (s *Server) PurgeDeletedReports(ctx context.Context) {
	t := time.NewTicker(time.Hour)
	defer t.Stop()
	for {
		if n, err := s.db.PurgeDeletedReports(ctx); err != nil {
			log.Printf("deleted reports: %v", err)
		} else if n > 0 {
			log.Printf("deleted reports: removed %d past their retention", n)
		}
		// Demo visitors of links that ended over 30 days ago (same hourly clean-up).
		if n, err := s.db.PurgeGuests(ctx); err != nil {
			log.Printf("demo visitors: %v", err)
		} else if n > 0 {
			log.Printf("demo visitors: removed %d from ended demo links", n)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}
