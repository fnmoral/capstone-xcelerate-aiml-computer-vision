package api

import (
	"errors"
	"net/http"
	"net/http/httputil"
	"net/url"
	"path"
	"strings"

	"github.com/gin-gonic/gin"

	"backend-api/internal/auth"
	"backend-api/internal/store"
)

// Share links: a view-only page with one incident's video and basic facts, for someone
// without an account (a regulator). The token is in the link only; the database keeps its
// hash. The public page gets the incident's time, place and outcome, never notes or staff.

const (
	defaultShareDays = 14
	maxShareDays     = 90
)

func (s *Server) createShareLink(c *gin.Context) {
	var in struct {
		Recipient string `json:"recipient"`
		Days      int    `json:"days"`
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		badRequest(c, "invalid JSON")
		return
	}
	in.Recipient = strings.TrimSpace(in.Recipient)
	if in.Recipient == "" || len(in.Recipient) > 120 {
		badRequest(c, "say who the link is for (at most 120 characters), e.g. WSIB claims")
		return
	}
	if in.Days == 0 {
		in.Days = defaultShareDays
	}
	if in.Days < 1 || in.Days > maxShareDays {
		badRequest(c, "a share link can last 1 to 90 days")
		return
	}
	token, hash, err := auth.NewToken()
	if err != nil {
		fail(c, err)
		return
	}
	link, err := s.db.CreateShareLink(c.Request.Context(), c.Param("id"), in.Recipient, hash, in.Days, actor(c))
	if err != nil {
		fail(c, err)
		return
	}
	// The only time the link is shown: it can't be rebuilt from the stored hash.
	c.JSON(http.StatusCreated, gin.H{"link": link, "url": s.appURL(c) + "/shared/" + token})
}

func (s *Server) listShareLinks(c *gin.Context) {
	links, err := s.db.ShareLinks(c.Request.Context(), c.Param("id"))
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"links": links})
}

func (s *Server) revokeShareLink(c *gin.Context) {
	if err := s.db.RevokeShareLink(c.Request.Context(), c.Param("id"), actor(c)); err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// sharedIncident resolves a share token to its incident (in the link's organization).
// An invalid, expired or revoked link answers 404 like an unknown one.
func (s *Server) sharedIncident(c *gin.Context) (*store.SharedLink, *store.Incident, bool) {
	link, err := s.db.SharedLinkByToken(c.Request.Context(), auth.HashToken(c.Param("token")))
	if errors.Is(err, store.ErrTokenInvalid) {
		c.JSON(http.StatusNotFound, gin.H{"error": "this link is invalid, has expired or was revoked"})
		return nil, nil, false
	}
	if err != nil {
		fail(c, err)
		return nil, nil, false
	}
	c.Request = c.Request.WithContext(store.WithTenant(c.Request.Context(), link.TenantID))
	inc, _, err := s.db.Incident(c.Request.Context(), link.IncidentID)
	if err != nil {
		fail(c, err)
		return nil, nil, false
	}
	return link, inc, true
}

// sharedMedia is the incident's clips and snapshots by file name (what the public page shows).
func sharedMedia(inc *store.Incident) (clips, snapshots map[string]string) {
	clips, snapshots = map[string]string{}, map[string]string{}
	add := func(name *string, clip, snap *string) {
		cam := "Camera"
		if name != nil && *name != "" {
			cam = *name
		}
		if clip != nil && *clip != "" {
			clips[path.Base(*clip)] = cam
		}
		if snap != nil && *snap != "" {
			snapshots[path.Base(*snap)] = cam
		}
	}
	add(inc.CameraName, inc.ClipKey, inc.SnapshotKey)
	for _, ic := range inc.Cameras {
		add(ic.CameraName, ic.ClipKey, ic.SnapshotKey)
	}
	return clips, snapshots
}

// sharedView is the public page's data: what happened, where and when, and the video.
func (s *Server) sharedView(c *gin.Context) {
	link, inc, ok := s.sharedIncident(c)
	if !ok {
		return
	}
	ctx := c.Request.Context()
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
	if err := s.db.ShareLinkViewed(ctx, link, c.ClientIP()); err != nil {
		fail(c, err)
		return
	}
	base := "/shared/" + url.PathEscape(c.Param("token")) + "/media/"
	type media struct {
		Camera   string  `json:"camera"`
		Clip     *string `json:"clip"`
		Snapshot *string `json:"snapshot"`
	}
	clips, snaps := sharedMedia(inc)
	byCam := map[string]*media{}
	var list []*media
	get := func(cam string) *media {
		if m, ok := byCam[cam]; ok {
			return m
		}
		m := &media{Camera: cam}
		byCam[cam] = m
		list = append(list, m)
		return m
	}
	for name, cam := range clips {
		u := base + "clips/" + url.PathEscape(name)
		get(cam).Clip = &u
	}
	for name, cam := range snaps {
		u := base + "snapshots/" + url.PathEscape(name)
		get(cam).Snapshot = &u
	}
	orgName := org.LegalName
	if orgName == "" {
		orgName = org.Name
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{
		"organization": orgName,
		"incident": gin.H{
			"started_at": inc.StartedAt, "recovered_at": inc.RecoveredAt, "duration_seconds": inc.DurationSeconds,
			"status": inc.Status, "location": inc.LocationLabel, "zone": inc.Zone,
		},
		"timezone":   settings.Timezone,
		"expires_at": link.ExpiresAt,
		"media":      list,
	})
}

// sharedFile streams one of the shared incident's clips or snapshots from stream-hub.
// Only that incident's files are served; Range requests (seeking in the video) pass through.
func (s *Server) sharedFile(c *gin.Context) {
	_, inc, ok := s.sharedIncident(c)
	if !ok {
		return
	}
	kind, name := c.Param("kind"), c.Param("name")
	clips, snaps := sharedMedia(inc)
	allowed := map[string]map[string]string{"clips": clips, "snapshots": snaps}[kind]
	if _, ok := allowed[name]; !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	target, err := url.Parse(s.cfg.StreamHubURL)
	if err != nil {
		fail(c, err)
		return
	}
	proxy := &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(target)
			r.Out.URL.Path = "/stream-hub/recordings/" + kind + "/" + name
			r.Out.URL.RawPath = ""
			r.Out.URL.RawQuery = ""
			r.Out.Header.Del("Cookie") // the viewer's own cookies are none of stream-hub's business
		},
		ModifyResponse: func(res *http.Response) error {
			res.Header.Set("Cache-Control", "private, max-age=300")
			res.Header.Set("X-Robots-Tag", "noindex")
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			w.WriteHeader(http.StatusBadGateway)
		},
	}
	// A video player hangs up mid-file all the time (seeking, closing the page): the proxy
	// then panics with ErrAbortHandler, and gin's recovery would log the request, token
	// included. The connection is gone either way, so let it end quietly.
	defer func() {
		if r := recover(); r != nil && r != http.ErrAbortHandler {
			panic(r)
		}
	}()
	proxy.ServeHTTP(c.Writer, c.Request)
}

// redactShareToken hides share tokens in logged paths: a logged link is a working link.
func redactShareToken(p string) string {
	const prefix = "/api/shared/"
	if !strings.HasPrefix(p, prefix) {
		return p
	}
	rest := p[len(prefix):]
	if i := strings.IndexByte(rest, '/'); i >= 0 {
		return prefix + "…" + rest[i:]
	}
	return prefix + "…"
}
