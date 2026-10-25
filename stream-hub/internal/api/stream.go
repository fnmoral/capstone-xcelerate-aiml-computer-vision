package api

import (
	"fmt"
	"net/http"
	"time"

	"stream-hub/internal/hub"

	"github.com/gin-gonic/gin"
)

const frameWaitTimeout = 5 * time.Second

// subscribe registers a temporary client on the broker for a camera.
// The returned function must be called to unregister it.
func (h *Handler) subscribe(c *gin.Context, cameraID string) (*hub.Client, func()) {
	client := &hub.Client{
		ID:       "http-" + c.Request.RemoteAddr + "-" + cameraID,
		SendChan: make(chan []byte, 256),
		TenantID: h.tenantID,
		CameraID: cameraID,
	}
	h.broker.RegisterClient(h.tenantID, cameraID, client)
	return client, func() { h.broker.UnregisterClient(h.tenantID, cameraID, client) }
}

// StreamMJPEG serves the live camera feed as multipart MJPEG,
// so it can be used directly in an <img src="..."> tag.
func (h *Handler) StreamMJPEG(c *gin.Context) {
	client, unsubscribe := h.subscribe(c, c.Param("id"))
	defer unsubscribe()

	w := c.Writer
	w.Header().Set("Content-Type", "multipart/x-mixed-replace; boundary=frame")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)

	ctx := c.Request.Context()
	for {
		select {
		case <-ctx.Done(): // browser closed the connection
			return
		case frame, ok := <-client.SendChan:
			if !ok {
				return
			}
			if _, err := fmt.Fprintf(w, "--frame\r\nContent-Type: image/jpeg\r\nContent-Length: %d\r\n\r\n", len(frame)); err != nil {
				return
			}
			if _, err := w.Write(frame); err != nil {
				return
			}
			if _, err := w.WriteString("\r\n"); err != nil {
				return
			}
			w.Flush()
		}
	}
}

// FrameJPEG returns the next available frame of a camera as a single JPEG.
func (h *Handler) FrameJPEG(c *gin.Context) {
	client, unsubscribe := h.subscribe(c, c.Param("id"))
	defer unsubscribe()

	select {
	case frame, ok := <-client.SendChan:
		if !ok {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "stream closed"})
			return
		}
		c.Header("Cache-Control", "no-store")
		c.Data(http.StatusOK, "image/jpeg", frame)
	case <-time.After(frameWaitTimeout):
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "no frames received from camera"})
	case <-c.Request.Context().Done():
	}
}
