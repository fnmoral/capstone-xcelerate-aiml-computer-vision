package api

import (
	"encoding/csv"
	"fmt"
	"net/http"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"backend-api/internal/store"
)

// actor is who is making the request. There are no user accounts yet, so every action is
// recorded as "Current user"; once sign-in exists, return the signed-in user here.
func actor(*gin.Context) string { return "Current user" }

// timeWindow reads ?from= and ?to= (RFC 3339; ?since= is the older name for from).
func timeWindow(c *gin.Context) (from, to *time.Time, ok bool) {
	parse := func(keys ...string) (*time.Time, bool) {
		for _, k := range keys {
			if v := c.Query(k); v != "" {
				t, err := time.Parse(time.RFC3339, v)
				if err != nil {
					c.JSON(http.StatusBadRequest, gin.H{"error": k + " must be an RFC 3339 time, e.g. 2026-10-23T08:00:00Z"})
					return nil, false
				}
				return &t, true
			}
		}
		return nil, true
	}
	if from, ok = parse("from", "since"); !ok {
		return nil, nil, false
	}
	to, ok = parse("to")
	return from, to, ok
}

var (
	severities    = map[string]bool{"": true, "low": true, "medium": true, "high": true, "critical": true}
	alertStatuses = map[string]bool{"": true, "open": true, "acknowledged": true, "resolved": true, "false_positive": true, "none": true}
	logKinds      = map[string]bool{"": true, "alert": true, "incident": true, "camera": true, "settings": true}
)

// incidentQuery reads the incident filters shared by the list and the export.
func incidentQuery(c *gin.Context, defaultLimit int) (store.IncidentFilter, bool) {
	f := store.IncidentFilter{
		Status: c.Query("status"), Severity: c.Query("severity"), CameraID: c.Query("camera_id"),
		Zone: c.Query("zone"), AlertStatus: c.Query("alert_status"),
	}
	if (f.Status != "" && !incidentStatuses[f.Status]) || !severities[f.Severity] || !alertStatuses[f.AlertStatus] {
		c.JSON(http.StatusBadRequest, gin.H{"error": "unknown status, severity or alert_status"})
		return f, false
	}
	f.Limit, _ = strconv.Atoi(c.DefaultQuery("limit", strconv.Itoa(defaultLimit)))
	var ok bool
	f.Since, f.Until, ok = timeWindow(c)
	return f, ok
}

func logQuery(c *gin.Context, defaultLimit int) (store.LogFilter, bool) {
	f := store.LogFilter{Kind: c.Query("kind"), CameraID: c.Query("camera_id"), IncidentID: c.Query("incident_id")}
	if !logKinds[f.Kind] {
		c.JSON(http.StatusBadRequest, gin.H{"error": "kind must be alert, incident, camera or settings"})
		return f, false
	}
	f.Limit, _ = strconv.Atoi(c.DefaultQuery("limit", strconv.Itoa(defaultLimit)))
	var ok bool
	f.Since, f.Until, ok = timeWindow(c)
	return f, ok
}

// ---------- activity log ----------

func (s *Server) listLogs(c *gin.Context) {
	f, ok := logQuery(c, 200)
	if !ok {
		return
	}
	list, err := s.db.Logs(c.Request.Context(), f)
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"entries": list})
}

// notifications: open fall alerts, and cameras that stopped working with alerts on.
func (s *Server) notifications(c *gin.Context) {
	ctx := c.Request.Context()
	alerts, err := s.db.Alerts(ctx, "open")
	if err != nil {
		fail(c, err)
		return
	}
	cams, err := s.db.Cameras(ctx)
	if err != nil {
		fail(c, err)
		return
	}
	down := []store.Camera{}
	for _, cam := range cams {
		if cam.Status == "error" && cam.AlertOffline {
			down = append(down, cam)
		}
	}
	c.JSON(http.StatusOK, gin.H{"alerts": alerts, "cameras": down})
}

// ---------- CSV exports ----------

// csvWriter starts a CSV download. Times are written in tz (see Server.zone), UTC if invalid.
func csvWriter(c *gin.Context, name, tz string) (*csv.Writer, *time.Location) {
	loc, err := time.LoadLocation(tz)
	if err != nil || tz == "" {
		loc = time.UTC
	}
	c.Header("Content-Type", "text/csv; charset=utf-8")
	c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename="fallguard-%s-%s.csv"`,
		name, time.Now().In(loc).Format("20060102-1504")))
	c.Writer.WriteString("\xEF\xBB\xBF") //nolint:errcheck // BOM: Excel then reads the file as UTF-8
	return csv.NewWriter(c.Writer), loc
}

// cell keeps spreadsheet apps from running text as a formula (=, +, -, @ at the start).
func cell(s string) string {
	if s != "" && strings.ContainsRune("=+-@\t\r", rune(s[0])) {
		return "'" + s
	}
	return s
}

func str(p *string) string {
	if p == nil {
		return ""
	}
	return cell(*p)
}

func when(t *time.Time, loc *time.Location) string {
	if t == nil {
		return ""
	}
	return t.In(loc).Format("2006-01-02 15:04:05")
}

func (s *Server) exportIncidents(c *gin.Context) {
	f, ok := incidentQuery(c, 10000)
	if !ok {
		return
	}
	list, err := s.db.Incidents(c.Request.Context(), f)
	if err != nil {
		fail(c, err)
		return
	}
	w, loc := csvWriter(c, "incidents", s.zone(c))
	tz := " (" + loc.String() + ")"
	w.Write([]string{ //nolint:errcheck // errors surface on Flush
		"Incident ID", "Started" + tz, "Recovered" + tz, "Down for (s)", "Status", "Severity",
		"Camera", "Location", "Zone", "Cameras that saw it", "Peak confidence",
		"Alert status", "Alert raised" + tz, "Acknowledged" + tz, "Acknowledged by",
		"Closed" + tz, "Closed by", "Notes", "Video",
	})
	for _, i := range list {
		names := make([]string, 0, len(i.Cameras))
		for _, ic := range i.Cameras {
			names = append(names, str(ic.CameraName))
		}
		row := []string{
			i.ID, when(&i.StartedAt, loc), when(i.RecoveredAt, loc), "", i.Status, i.Severity,
			str(i.CameraName), str(i.LocationLabel), str(i.Zone), strings.Join(names, "; "), "",
			"", "", "", "", "", "", notesCell(i.NoteList, loc), "",
		}
		if i.ClipKey != nil { // a link the app can open (same origin as the export)
			row[18] = "/api/clips/" + path.Base(*i.ClipKey)
		}
		if i.DurationSeconds != nil {
			row[3] = strconv.Itoa(*i.DurationSeconds)
		}
		if i.PeakConfidence != nil {
			row[10] = strconv.FormatFloat(float64(*i.PeakConfidence), 'f', 2, 32)
		}
		if a := i.Alert; a != nil {
			row[11], row[12] = a.Status, when(&a.TriggeredAt, loc)
			row[13], row[14] = when(a.AcknowledgedAt, loc), str(a.AcknowledgedBy)
			row[15], row[16] = when(a.ClosedAt, loc), str(a.ClosedBy)
		}
		w.Write(row) //nolint:errcheck
	}
	w.Flush()
}

// notesCell puts all of an incident's notes in one cell, one per line:
// "2026-10-23 14:02 Nurse Ana: Checked, patient is fine".
func notesCell(notes []store.Note, loc *time.Location) string {
	lines := make([]string, len(notes))
	for i, n := range notes {
		lines[i] = n.At.In(loc).Format("2006-01-02 15:04") + " " + n.Author + ": " + n.Text
	}
	return cell(strings.Join(lines, "\n"))
}

func (s *Server) exportLogs(c *gin.Context) {
	f, ok := logQuery(c, 10000)
	if !ok {
		return
	}
	list, err := s.db.Logs(c.Request.Context(), f)
	if err != nil {
		fail(c, err)
		return
	}
	w, loc := csvWriter(c, "activity-log", s.zone(c))
	w.Write([]string{"Time (" + loc.String() + ")", "Type", "Action", "What happened", "By", //nolint:errcheck
		"Camera", "Camera ID", "Incident ID", "Item ID"})
	for _, e := range list {
		by := "System"
		if e.Actor != nil {
			by = cell(*e.Actor)
		}
		w.Write([]string{when(&e.At, loc), e.Kind, e.Action, cell(e.Message), by, //nolint:errcheck
			str(e.CameraName), str(e.CameraID), str(e.IncidentID), str(e.TargetID)})
	}
	w.Flush()
}
