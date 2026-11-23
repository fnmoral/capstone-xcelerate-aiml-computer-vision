package api

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log"
	"net"
	"net/http"
	"net/url"
	"strings"

	"github.com/gin-gonic/gin"

	"backend-api/internal/auth"
	"backend-api/internal/store"
)

// Phone cameras: a phone streaming app (e.g. Larix Broadcaster) sends its video over RTMPS
// to the camera relay (MediaMTX, the test-camera service) from any network. The gateway reads
// it back from the relay over RTSP inside the VM, like any other camera. The relay asks
// relayAuth whether each connection is allowed.

// phoneUser is the RTMP user name in every phone camera's address; the password is per camera.
const phoneUser = "phone"

// phoneLinks is what the app shows once, when a phone camera is added or gets a new password.
type phoneLinks struct {
	ID         string `json:"id"`
	Status     string `json:"status,omitempty"`
	Name       string `json:"name"`
	PublishURL string `json:"publish_url"` // full address for the streaming app
	ServerURL  string `json:"server_url"`  // for apps that ask for a server and a stream key
	StreamKey  string `json:"stream_key"`
	SetupURL   string `json:"setup_url"` // larix:// link: scanned as a QR code, it fills Larix in

	// Plain RTMP (no encryption) for apps that can't do RTMPS, e.g. Streamza ("" = not offered).
	RTMPServerURL  string `json:"rtmp_server_url"`
	RTMPPublishURL string `json:"rtmp_publish_url"`
	Path           string `json:"path"`
	RelayRTSP      string `json:"relay_rtsp"` // where the gateway reads it
	Description    string `json:"description"`
}

func (s *Server) phoneLinks(id, name, path, token string) phoneLinks {
	base := strings.TrimRight(s.cfg.PhoneRelayURL, "/")
	// RTMP apps (Larix, OBS) want rtmp(s)://host:port/<app>/<stream>: the app is "phone" and
	// the stream key is the id plus the credentials. The relay joins them back into the path
	// "phone/<id>". (Phone cameras added before this had the one-part path "phone-<id>".)
	server, stream := base, path
	if app, id, ok := strings.Cut(path, "/"); ok {
		server, stream = base+"/"+app, id
	}
	key := stream + "?user=" + phoneUser + "&pass=" + token
	publish := server + "/" + key
	// Larix "Grove" setup link, keys in Larix's documented order (url first).
	setup := "larix://set/v1?" + url.QueryEscape("conn[][url]") + "=" + url.QueryEscape(publish) +
		"&" + url.QueryEscape("conn[][name]") + "=" + url.QueryEscape("FallGuard: "+name) +
		"&" + url.QueryEscape("conn[][overwrite]") + "=on"
	out := phoneLinks{ID: id, Name: name, PublishURL: publish, ServerURL: server, StreamKey: key,
		SetupURL: setup, Path: path, RelayRTSP: s.relayRTSP(path),
		Description: "Shown once. Scan the QR codes with the phone, or copy them into a streaming app."}
	if plain := strings.TrimRight(s.cfg.PhoneRTMPURL, "/"); plain != "" {
		out.RTMPServerURL = plain + strings.TrimPrefix(server, base)
		out.RTMPPublishURL = out.RTMPServerURL + "/" + key
	}
	return out
}

func (s *Server) relayRTSP(path string) string {
	return strings.TrimRight(s.cfg.RelayRTSPURL, "/") + "/" + path
}

func (s *Server) phoneCamerasEnabled(c *gin.Context) bool {
	if s.cfg.PhoneRelayURL == "" {
		c.JSON(http.StatusConflict, gin.H{"error": "phone cameras aren't set up on this server (PHONE_RELAY_URL is empty)",
			"code": "no_phone_relay"})
		return false
	}
	// Only the cloud gateway can read the relay the phones push to.
	if st, err := s.gatewayState(c.Request.Context()); err == nil && !st.phoneCamerasOn(s.cfg.PhoneRelayURL) {
		c.JSON(http.StatusConflict, gin.H{"error": "phone cameras need the Cloud gateway in use; an on-site gateway is in use (Settings → Gateways)",
			"code": "phone_needs_cloud_gateway"})
		return false
	}
	return true
}

// addPhoneCamera adds a camera that a phone streams to: POST /api/cameras/phone.
func (s *Server) addPhoneCamera(c *gin.Context) {
	if !s.phoneCamerasEnabled(c) {
		return
	}
	var in cameraInput
	if err := c.ShouldBindJSON(&in); err != nil || in.Name == nil || strings.TrimSpace(*in.Name) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "name is required"})
		return
	}
	name := strings.TrimSpace(*in.Name)
	b := make([]byte, 6)
	if _, err := rand.Read(b); err != nil {
		fail(c, err)
		return
	}
	path := "phone/" + hex.EncodeToString(b)
	token, hash, err := auth.NewToken()
	if err != nil {
		fail(c, err)
		return
	}
	ctx := c.Request.Context()
	rtsp := s.relayRTSP(path)
	client, inUse := s.gwInUse(ctx)
	cam, err := client.addCamera(ctx, name, rtsp, "", "")
	if err != nil {
		fail(c, err)
		return
	}
	if err := s.db.UpsertCamera(ctx, cam.ID, name, rtsp, dbStatus(cam.Status), trimmed(in.Location), trimmed(in.Zone)); err != nil {
		fail(c, err)
		return
	}
	s.recordGateway(ctx, inUse, cam.ID)
	if err := s.db.AddPhoneCamera(ctx, cam.ID, path, hash); err != nil {
		fail(c, err)
		return
	}
	s.auditCamera(c, "camera.added", cam.ID, name, "Phone camera added", gin.H{
		"rtsp_url": rtsp, "location": trimmed(in.Location), "zone": trimmed(in.Zone), "phone": true})
	out := s.phoneLinks(cam.ID, name, path, token)
	out.Status = cam.Status
	c.JSON(http.StatusCreated, out)
}

// newPhoneLink gives a phone camera a new password and QR code: POST /api/cameras/:id/phone-link.
// The old password stops working; a phone still streaming with it is cut off at its next connection.
func (s *Server) newPhoneLink(c *gin.Context) {
	if !s.phoneCamerasEnabled(c) {
		return
	}
	token, hash, err := auth.NewToken()
	if err != nil {
		fail(c, err)
		return
	}
	ctx, id := c.Request.Context(), c.Param("id")
	path, err := s.db.RotatePhoneCamera(ctx, id, hash)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "not a phone camera"})
			return
		}
		fail(c, err)
		return
	}
	name := ""
	if cams, err := s.db.Cameras(ctx); err == nil {
		for _, cam := range cams {
			if cam.ID == id {
				name = cam.Name
			}
		}
	}
	s.auditCamera(c, "camera.phone_link", id, name, "New phone camera QR code (the old one stopped working)", nil)
	c.JSON(http.StatusOK, s.phoneLinks(id, name, path, token))
}

// relayAuthRequest is what MediaMTX sends for each connection (authMethod: http).
type relayAuthRequest struct {
	User     string `json:"user"`
	Password string `json:"password"`
	IP       string `json:"ip"`
	Action   string `json:"action"`   // publish | read | playback | api | metrics | pprof
	Path     string `json:"path"`     // e.g. phone-3f9a1c2b7d4e
	Protocol string `json:"protocol"` // rtsp | rtmp | hls | webrtc | srt
}

// relayAuth answers the camera relay: POST /internal/relay-auth (machine to machine; not
// under /api, so neither nginx nor Caddy forward it, and only private addresses may call it).
//   - RTSP: allowed. The relay's RTSP port is reachable only inside the VM and its Docker
//     network (the gateway reading cameras, send-camera.sh through the SSH tunnel).
//   - RTMP(S), the only port open to the internet: publishing only, with the phone camera's
//     current password for that exact path.
//   - Anything else: refused.
func (s *Server) relayAuth(c *gin.Context) {
	if !privateCaller(c.Request.RemoteAddr) {
		c.Status(http.StatusForbidden)
		return
	}
	var in relayAuthRequest
	if err := c.ShouldBindJSON(&in); err != nil {
		c.Status(http.StatusBadRequest)
		return
	}
	switch {
	case in.Protocol == "rtsp":
		c.Status(http.StatusOK)
		return
	case in.Protocol == "rtmp" && in.Action == "publish" && in.User == phoneUser && in.Password != "" &&
		(strings.HasPrefix(in.Path, "phone/") || strings.HasPrefix(in.Path, "phone-")):
		ok, err := s.db.RelayPublishAllowed(c.Request.Context(), in.Path, auth.HashToken(in.Password))
		if err != nil {
			log.Printf("relay auth: %v", err)
			c.Status(http.StatusServiceUnavailable)
			return
		}
		if ok {
			log.Printf("relay: phone camera %s connected from %s", in.Path, in.IP)
			c.Status(http.StatusOK)
			return
		}
	}
	log.Printf("relay: refused %s %s %q from %s", in.Protocol, in.Action, in.Path, in.IP)
	c.Status(http.StatusUnauthorized)
}

// privateCaller reports whether a request comes from this machine or a private network
// (the Docker network the relay is on).
func privateCaller(remoteAddr string) bool {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	ip := net.ParseIP(host)
	return ip != nil && (ip.IsLoopback() || ip.IsPrivate())
}
