package api

import (
	"context"
	"errors"
	"log"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"backend-api/internal/store"
)

// Gateways: the cloud gateway on the server (it can only read phone cameras, which push to
// the relay) and on-site gateways next to the cameras. One is in use at a time: the one an
// admin chose in Settings → Gateways (kept even while offline), else automatic: an on-site
// gateway that is online, else the cloud one. A gateway that signed up without an address
// (older gateways, the local stack) is reached at GATEWAY_URL.

const onlineCacheFor = 10 * time.Second

type gatewayPool struct {
	mu      sync.Mutex
	clients map[string]gateway    // by URL
	checked map[string]onlineMark // by gateway ID
}

type onlineMark struct {
	ok bool
	at time.Time
}

func newGatewayPool() *gatewayPool {
	return &gatewayPool{clients: map[string]gateway{}, checked: map[string]onlineMark{}}
}

// clientFor is the client for a gateway address ("" = GATEWAY_URL).
func (s *Server) clientFor(url string) gateway {
	if url == "" {
		return s.gateway
	}
	s.gws.mu.Lock()
	defer s.gws.mu.Unlock()
	g, ok := s.gws.clients[url]
	if !ok {
		g = gateway{newClient("gateway-back", url, 8*time.Second)}
		s.gws.clients[url] = g
	}
	return g
}

// online asks each gateway whether it answers (each at most every 10 s).
func (s *Server) online(ctx context.Context, list []store.Gateway) map[string]bool {
	out := map[string]bool{}
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, g := range list {
		s.gws.mu.Lock()
		mark, ok := s.gws.checked[g.ID]
		s.gws.mu.Unlock()
		if ok && time.Since(mark.at) < onlineCacheFor {
			out[g.ID] = mark.ok
			continue
		}
		wg.Add(1)
		go func(g store.Gateway) {
			defer wg.Done()
			cctx, cancel := context.WithTimeout(ctx, 2*time.Second)
			defer cancel()
			up := s.clientFor(g.URL).do(cctx, http.MethodGet, "/gateway/actions/health", nil, nil) == nil
			if up {
				if err := s.db.GatewaySeen(ctx, g.ID); err != nil {
					log.Printf("gateway %s: %v", g.ID, err)
				}
			}
			s.gws.mu.Lock()
			s.gws.checked[g.ID] = onlineMark{ok: up, at: time.Now()}
			s.gws.mu.Unlock()
			mu.Lock()
			out[g.ID] = up
			mu.Unlock()
		}(g)
	}
	wg.Wait()
	return out
}

// gatewayState is the gateways, which answer, and the one in use (nil: none signed up yet,
// GATEWAY_URL is used).
type gatewayState struct {
	list   []store.Gateway
	online map[string]bool
	inUse  *store.Gateway
	chosen bool // an admin chose it; else automatic
}

func (s *Server) gatewayState(ctx context.Context) (gatewayState, error) {
	list, err := s.db.Gateways(ctx)
	if err != nil {
		return gatewayState{}, err
	}
	st := gatewayState{list: list, online: s.online(ctx, list)}
	chosen, err := s.db.ActiveGatewayID(ctx)
	if err != nil {
		return st, err
	}
	st.inUse, st.chosen = pickGateway(list, st.online, chosen)
	return st, nil
}

// pickGateway: the chosen gateway if it still exists (even offline); else automatic: the
// on-site gateway seen most recently among those online, else the cloud gateway (an online
// one first), else the first gateway.
func pickGateway(list []store.Gateway, online map[string]bool, chosen *string) (*store.Gateway, bool) {
	if chosen != nil {
		for i := range list {
			if list[i].ID == *chosen {
				return &list[i], true
			}
		}
	}
	var onsite, cloud *store.Gateway
	for i := range list {
		g := &list[i]
		switch g.Kind {
		case store.GatewayOnsite:
			if online[g.ID] && (onsite == nil || seenAfter(g.LastSeenAt, onsite.LastSeenAt)) {
				onsite = g
			}
		case store.GatewayCloud:
			if cloud == nil || (online[g.ID] && !online[cloud.ID]) {
				cloud = g
			}
		}
	}
	switch {
	case onsite != nil:
		return onsite, false
	case cloud != nil:
		return cloud, false
	case len(list) > 0:
		return &list[0], false
	}
	return nil, false
}

func seenAfter(a, b *time.Time) bool {
	return a != nil && (b == nil || a.After(*b))
}

// gw is the client of the gateway in use.
func (s *Server) gw(ctx context.Context) gateway {
	g, _ := s.gwInUse(ctx)
	return g
}

// gwInUse is the gateway in use and its client (nil gateway: none signed up, GATEWAY_URL).
func (s *Server) gwInUse(ctx context.Context) (gateway, *store.Gateway) {
	st, err := s.gatewayState(ctx)
	if err != nil {
		log.Printf("gateways: %v", err)
	}
	return st.client(s), st.inUse
}

func (st gatewayState) client(s *Server) gateway {
	if st.inUse == nil {
		return s.gateway
	}
	return s.clientFor(st.inUse.URL)
}

// gatewayOfCamera is the client of the gateway a camera was added on, if that gateway is
// known and answers; else the gateway in use.
func (s *Server) gatewayOfCamera(ctx context.Context, cameraID string) gateway {
	st, err := s.gatewayState(ctx)
	if err != nil {
		log.Printf("gateways: %v", err)
	}
	if cams, err := s.db.Cameras(ctx); err == nil {
		for _, d := range cams {
			if d.ID == cameraID && d.GatewayID != nil {
				if g := st.find(*d.GatewayID); g != nil && st.online[g.ID] {
					return s.clientFor(g.URL)
				}
			}
		}
	}
	return st.client(s)
}

// recordGateway notes which gateway a camera was just added on.
func (s *Server) recordGateway(ctx context.Context, g *store.Gateway, cameraID string) {
	if g == nil {
		return
	}
	if err := s.db.SetCamerasGateway(ctx, g.ID, []string{cameraID}); err != nil {
		log.Printf("camera %s: gateway: %v", cameraID, err)
	}
}

// phoneCamerasOn: phone cameras need the relay and the cloud gateway in use (only it can
// read the relay). A deployment without registered gateways (local stack) keeps the old rule.
func (st gatewayState) phoneCamerasOn(relay string) bool {
	return relay != "" && (st.inUse == nil || st.inUse.Kind == store.GatewayCloud)
}

type gatewayView struct {
	store.Gateway
	Online bool `json:"online"`
	InUse  bool `json:"in_use"`
}

func (st gatewayState) view(g store.Gateway) gatewayView {
	return gatewayView{Gateway: g, Online: st.online[g.ID], InUse: st.inUse != nil && st.inUse.ID == g.ID}
}

// inUseView is the gateway in use for the Cameras page (nil: none signed up).
func (st gatewayState) inUseView() *gatewayView {
	if st.inUse == nil {
		return nil
	}
	v := st.view(*st.inUse)
	return &v
}

func (st gatewayState) find(id string) *store.Gateway {
	for i := range st.list {
		if st.list[i].ID == id {
			return &st.list[i]
		}
	}
	return nil
}

func (st gatewayState) response() gin.H {
	views := make([]gatewayView, 0, len(st.list))
	for _, g := range st.list {
		views = append(views, st.view(g))
	}
	mode := "automatic"
	if st.chosen {
		mode = "chosen"
	}
	var inUse *string
	if st.inUse != nil {
		inUse = &st.inUse.ID
	}
	return gin.H{"mode": mode, "in_use": inUse, "gateways": views}
}

// listGateways: GET /api/gateways.
func (s *Server) listGateways(c *gin.Context) {
	st, err := s.gatewayState(c.Request.Context())
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, st.response())
}

// setGateway: PUT /api/gateways/active {gateway_id: "<id>" | null (automatic)}. Cameras
// stay with their gateway: the streaming cameras of the gateway no longer in use are paused,
// and those paused by an earlier switch on the new one are resumed.
func (s *Server) setGateway(c *gin.Context) {
	var in struct {
		GatewayID *string `json:"gateway_id"`
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		badRequest(c, "gateway_id: a gateway's id, or null for automatic")
		return
	}
	ctx := c.Request.Context()
	before, err := s.gatewayState(ctx)
	if err != nil {
		fail(c, err)
		return
	}
	label := "automatic"
	if in.GatewayID != nil {
		g := before.find(*in.GatewayID)
		if g == nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "no such gateway"})
			return
		}
		label = g.DisplayName
	}
	if err := s.db.SetActiveGateway(ctx, in.GatewayID, label, actor(c)); err != nil {
		fail(c, err)
		return
	}
	after, err := s.gatewayState(ctx)
	if err != nil {
		fail(c, err)
		return
	}
	if before.inUse != nil && after.inUse != nil && before.inUse.ID != after.inUse.ID {
		s.switchGatewayCameras(c, before, after)
	}
	c.JSON(http.StatusOK, after.response())
}

// switchGatewayCameras pauses the old gateway's streaming cameras (marked, so switching back
// resumes them) and resumes the marked cameras of the new one. Best effort: a gateway that
// doesn't answer is skipped.
func (s *Server) switchGatewayCameras(c *gin.Context, before, after gatewayState) {
	ctx := c.Request.Context()
	if old := before.inUse; before.online[old.ID] {
		if cams, err := s.clientFor(old.URL).cameras(ctx); err == nil {
			var paused []string
			for _, cam := range cams {
				if cam.Status == "paused" {
					continue
				}
				if _, err := s.clientFor(old.URL).camera(ctx, "pause", cam.ID); err != nil {
					log.Printf("gateway switch: pausing %s: %v", cam.ID, err)
					continue
				}
				if _, _, err := s.db.SetCameraStatus(ctx, cam.ID, "disabled"); err != nil {
					log.Printf("gateway switch: %s: %v", cam.ID, err)
				}
				paused = append(paused, cam.ID)
			}
			if err := s.db.MarkSwitchPaused(ctx, paused, true); err != nil {
				log.Printf("gateway switch: %v", err)
			}
		}
	}
	if cur := after.inUse; after.online[cur.ID] {
		ids, err := s.db.SwitchPausedIDs(ctx, cur.ID)
		if err != nil {
			log.Printf("gateway switch: %v", err)
			return
		}
		var resumed []string
		for _, id := range ids {
			if _, err := s.clientFor(cur.URL).camera(ctx, "resume", id); err != nil {
				log.Printf("gateway switch: resuming %s: %v", id, err)
				continue
			}
			if _, _, err := s.db.SetCameraStatus(ctx, id, "online"); err != nil {
				log.Printf("gateway switch: %s: %v", id, err)
			}
			resumed = append(resumed, id)
		}
		if err := s.db.MarkSwitchPaused(ctx, resumed, false); err != nil {
			log.Printf("gateway switch: %v", err)
		}
	}
}

// updateGateway: PATCH /api/gateways/:id {name, location}.
func (s *Server) updateGateway(c *gin.Context) {
	var in struct {
		Name     *string `json:"name"`
		Location *string `json:"location"`
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		badRequest(c, "invalid JSON")
		return
	}
	if in.Name != nil {
		n := strings.TrimSpace(*in.Name)
		if n == "" || len(n) > 60 {
			badRequest(c, "name: the gateway's place, 1 to 60 characters (e.g. Office server)")
			return
		}
		in.Name = &n
	}
	if in.Location != nil {
		l := strings.TrimSpace(*in.Location)
		if len(l) > 120 {
			badRequest(c, "location: at most 120 characters")
			return
		}
		in.Location = &l
	}
	if err := s.db.UpdateGateway(c.Request.Context(), c.Param("id"), in.Name, in.Location, actor(c)); err != nil {
		fail(c, err)
		return
	}
	s.listGateways(c)
}

// deleteGateway: DELETE /api/gateways/:id?remove_cameras=true. Not the gateway in use.
// Its cameras are removed too when asked (from the gateway as well, if it answers);
// otherwise they stay in the database and history, on no gateway.
func (s *Server) deleteGateway(c *gin.Context) {
	ctx, id := c.Request.Context(), c.Param("id")
	st, err := s.gatewayState(ctx)
	if err != nil {
		fail(c, err)
		return
	}
	g := st.find(id)
	if g == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "no such gateway"})
		return
	}
	if st.inUse != nil && st.inUse.ID == id {
		c.JSON(http.StatusConflict, gin.H{"error": "this gateway is in use: choose another one (or automatic) first",
			"code": "gateway_in_use"})
		return
	}
	removed := 0
	if c.Query("remove_cameras") == "true" {
		ids, err := s.db.GatewayCameraIDs(ctx, id)
		if err != nil {
			fail(c, err)
			return
		}
		for _, camID := range ids {
			if st.online[id] {
				if err := s.clientFor(g.URL).deleteCamera(ctx, camID); err != nil {
					log.Printf("removing gateway %s: camera %s: %v", id, camID, err)
				}
			}
			name, err := s.db.DeleteCamera(ctx, camID)
			if err != nil {
				fail(c, err)
				return
			}
			if err := s.db.DeletePhoneCamera(ctx, camID); err != nil {
				log.Printf("removing phone camera %s: %v", camID, err)
			}
			s.auditCamera(c, "camera.removed", camID, name, "Camera removed (with gateway "+g.DisplayName+")", nil)
			removed++
		}
	}
	if _, err := s.db.DeleteGateway(ctx, id, actor(c)); err != nil {
		fail(c, err)
		return
	}
	s.gws.mu.Lock()
	delete(s.gws.checked, id)
	s.gws.mu.Unlock()
	c.JSON(http.StatusOK, gin.H{"ok": true, "cameras_removed": removed})
}

// gatewayConfigOf: GET / PUT /api/gateways/:id/config, the gateway's own connection settings
// (where it sends video). The gateway must be online.
func (s *Server) gatewayConfigOf(c *gin.Context) {
	ctx := c.Request.Context()
	st, err := s.gatewayState(ctx)
	if err != nil {
		fail(c, err)
		return
	}
	g := st.find(c.Param("id"))
	if g == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "no such gateway"})
		return
	}
	if !st.online[g.ID] {
		c.JSON(http.StatusConflict, gin.H{"error": g.DisplayName + " is offline", "code": "gateway_offline"})
		return
	}
	s.proxyGatewayConfig(c, s.clientFor(g.URL))
}

func (s *Server) proxyGatewayConfig(c *gin.Context, g gateway) {
	var body any
	if c.Request.Method == http.MethodPut {
		if err := c.ShouldBindJSON(&body); err != nil {
			badRequest(c, "invalid JSON")
			return
		}
	}
	var out any
	if err := g.do(c.Request.Context(), c.Request.Method, "/gateway/actions/config", body, &out); err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, out)
}

var gatewayURL = regexp.MustCompile(`^https?://[A-Za-z0-9._-]+(:[0-9]{1,5})?/?$`)

// gatewayCaller: gateway sign-up only from the server itself or a private network, and not
// through the web proxy (nginx adds X-Forwarded-For to every request it forwards). A gateway
// reaches the API directly (Docker network) or through its SSH tunnel; a sign-up from the
// internet could otherwise point the API at any address.
func gatewayCaller(c *gin.Context) bool {
	return privateCaller(c.Request.RemoteAddr) && c.GetHeader("X-Forwarded-For") == "" && c.GetHeader("X-Real-IP") == ""
}

var errGatewaySignup = errors.New("gateway sign-up is only accepted from the server or its private network")
