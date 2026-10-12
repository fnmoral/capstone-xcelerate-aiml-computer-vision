package api

import (
	"net/http"

	"stream-hub/internal/hub"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

type Handler struct {
	broker *hub.StreamBroker
}

// NewHandler creates a new API handler instance with a broker reference.
func NewHandler(broker *hub.StreamBroker) *Handler {
	return &Handler{broker: broker}
}

// RegisterRoutes registers all HTTP and WebSocket routes to the Gin engine.
func (h *Handler) RegisterRoutes(router *gin.Engine) {
	router.GET("/health", h.HealthCheck)
	router.GET("/ws/:tenant_id/:camera_id", h.StreamWebSocket)
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

// StreamWebSocket upgrades HTTP connections to WebSockets and streams frames to frontend clients.
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
		SendChan: make(chan []byte, 256),
		TenantID: tenantID,
		CameraID: cameraID,
	}

	h.broker.RegisterClient(tenantID, cameraID, client)
	defer h.broker.UnregisterClient(tenantID, cameraID, client)

	// Stream frames from the broker channel down to the WebSocket client
	for frame := range client.SendChan {
		if err := conn.WriteMessage(websocket.BinaryMessage, frame); err != nil {
			break
		}
	}
}
