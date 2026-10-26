// Package camera provides the HTTP handlers for the camera management API.
package camera

import (
	"errors"
	"net/http"

	"gateway-back/internal/config"

	"github.com/gin-gonic/gin"
)

// Handler holds the dependencies required to handle camera-related HTTP requests.
type Handler struct {
	service Service
	cfg     *config.Config
}

// NewHandler creates a new Handler with the given camera service and configuration reference.
func NewHandler(service Service, cfg *config.Config) *Handler {
	return &Handler{
		service: service,
		cfg:     cfg,
	}
}

// RegisterRoutes registers the camera-related routes on the provided router group.
func (h *Handler) RegisterRoutes(router *gin.RouterGroup) {
	cams := router.Group("/cameras")
	{
		cams.POST("", h.AddCamera)
		cams.GET("", h.GetCameras)
		cams.DELETE("/:id", h.RemoveCamera)
		cams.POST("/:id/pause", h.PauseCamera)
		cams.POST("/:id/resume", h.ResumeCamera)
	}
	router.GET("/health", h.HealthCheck)
	router.GET("/limits", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"max_streaming": MaxStreaming, "max_saved": MaxSaved})
	})
}

// AddCamera handles the creation of a new camera ensuring gateway information is updated first.
func (h *Handler) AddCamera(c *gin.Context) {
	// Check if gateway information has been updated before allowing camera addition.
	if !h.cfg.GatewayInfoUpdated {
		c.JSON(http.StatusForbidden, gin.H{"Error": "Gateway information must be updated before adding cameras"})
		return
	}

	var dto CreateCameraDTO
	if err := c.ShouldBindJSON(&dto); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"Error": err.Error()})
		return
	}

	// ID of the local tenant assigned at the gateway.
	cam, err := h.service.AddCamera(dto, h.cfg.TenantID)
	if err != nil {
		if errors.Is(err, ErrMaxCamerasReached) {
			c.JSON(http.StatusConflict, gin.H{"Error": err.Error()})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"Error": err.Error()})
		return
	}

	c.JSON(http.StatusCreated, cam)
}

// GetCameras handles the retrieval of all registered cameras.
func (h *Handler) GetCameras(c *gin.Context) {
	cameras, err := h.service.GetCameras()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"Error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, cameras)
}

// RemoveCamera handles the removal of a camera by its ID.
func (h *Handler) RemoveCamera(c *gin.Context) {
	id := c.Param("id")
	if err := h.service.RemoveCamera(id); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"Error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "Camera successfully removed."})
}

// PauseCamera stops a camera's stream without deleting it.
func (h *Handler) PauseCamera(c *gin.Context) {
	h.respondCamera(c, h.service.PauseCamera)
}

// ResumeCamera restarts a paused camera's stream.
func (h *Handler) ResumeCamera(c *gin.Context) {
	h.respondCamera(c, h.service.ResumeCamera)
}

func (h *Handler) respondCamera(c *gin.Context, action func(id string) (*Camera, error)) {
	cam, err := action(c.Param("id"))
	if err != nil {
		if errors.Is(err, ErrCameraNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"Error": err.Error()})
			return
		}
		if errors.Is(err, ErrMaxStreaming) {
			c.JSON(http.StatusConflict, gin.H{"Error": err.Error()})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"Error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, cam)
}

// HealthCheck verifies service status.
func (h *Handler) HealthCheck(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}
