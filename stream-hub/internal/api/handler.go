package api

import (
	"encoding/binary"
	"net/http"

	"stream-hub/internal/hub"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

type Handler struct {
	broker   *hub.StreamBroker
	tenantID string // tenant used by the HTTP video routes (the WebSocket takes it from the URL)
}

// NewHandler creates a new API handler instance with a broker reference.
func NewHandler(broker *hub.StreamBroker, tenantID string) *Handler {
	return &Handler{broker: broker, tenantID: tenantID}
}

// RegisterRoutes registers all HTTP and WebSocket routes to the Gin engine.
func (h *Handler) RegisterRoutes(router *gin.Engine) {
	router.GET("/health", h.HealthCheck)
	// router.GET("/ws/:tenant_id/:camera_id", h.StreamWebSocket)

	// Live video for browsers (same public paths the frontend already used)
	api := router.Group("/stream-hub")
	api.GET("/cameras/:id/stream", h.StreamMJPEG)
	api.GET("/cameras/:id/frame.jpg", h.FrameJPEG)
	api.GET("/ws/:tenant_id/:camera_id", h.StreamWebSocket)

}

// HealthCheck verifies service status.
func (h *Handler) HealthCheck(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow cross-origin requests for frontend clients during development
	},
}

// StreamWebSocket upgrades HTTP connections to WebSockets and streams a camera to a frontend client.
//
// Binary messages carry the video, one Annex B NALU each:
//   - default (v=1): the bare NALU, for the JMuxer-based player.
//   - ?v=2: [8 bytes big-endian int64 PTS, Unix ms][NALU]. Every NALU of one picture has the
//     same PTS, which the frontend uses to group them and to line detections up with the video.
//
// Text messages carry the ml-service results (detections and incident events) as JSON;
// clients that don't handle them can ignore them.
func (h *Handler) StreamWebSocket(c *gin.Context) {
	tenantID := c.Param("tenant_id")
	cameraID := c.Param("camera_id")

	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	client := &hub.Client{
		ID:       conn.RemoteAddr().String(),
		SendChan: make(chan hub.Frame, 256),
		MetaChan: make(chan []byte, 64),
		TenantID: tenantID,
		CameraID: cameraID,
	}

	h.broker.RegisterClient(tenantID, cameraID, client)
	defer h.broker.UnregisterClient(tenantID, cameraID, client)

	video := videoWriter{
		conn:     conn,
		broker:   h.broker,
		tenantID: tenantID,
		cameraID: cameraID,
		client:   client,
		withPTS:  c.Query("v") == "2",
	}

	// One goroutine writes to the connection: gorilla/websocket allows a single writer.
	for {
		select {
		case frame, ok := <-client.SendChan:
			if !ok {
				return
			}
			if err := video.write(frame); err != nil {
				return
			}
		case meta, ok := <-client.MetaChan:
			if !ok {
				return
			}
			if err := conn.WriteMessage(websocket.TextMessage, meta); err != nil {
				return
			}
		}
	}
}

// videoWriter sends video frames to one client, starting (and restarting after
// dropped frames) at a keyframe preceded by the cached SPS and PPS.
type videoWriter struct {
	conn     *websocket.Conn
	broker   *hub.StreamBroker
	tenantID string
	cameraID string
	client   *hub.Client
	withPTS  bool // protocol v2: prefix every NALU with its PTS
	synced   bool // true once the client has received SPS + PPS + an IDR
}

func (v *videoWriter) write(frame hub.Frame) error {
	// The broker dropped frames for this client: its decoder needs a new keyframe.
	if v.client.NeedsResync() {
		v.synced = false
	}

	if !v.synced {
		if hub.NALType(frame.Data) != 5 { // drop P frames until a keyframe arrives
			return nil
		}
		sps, pps := v.broker.ParamSets(v.tenantID, v.cameraID)
		for _, ps := range [][]byte{sps, pps} {
			if ps == nil {
				continue
			}
			// Same PTS as the keyframe, so the frontend groups them into one picture.
			if err := v.send(frame.PTS, ps); err != nil {
				return err
			}
		}
		v.synced = true
	}
	return v.send(frame.PTS, frame.Data)
}

func (v *videoWriter) send(pts int64, nalu []byte) error {
	if !v.withPTS {
		return v.conn.WriteMessage(websocket.BinaryMessage, nalu)
	}
	msg := make([]byte, 8+len(nalu))
	binary.BigEndian.PutUint64(msg[:8], uint64(pts))
	copy(msg[8:], nalu)
	return v.conn.WriteMessage(websocket.BinaryMessage, msg)
}
