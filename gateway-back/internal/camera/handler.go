// Package camera provides the HTTP handlers for the camera management API.
//
// This file implements the Gin handlers that expose the camera service
// operations (add, list, and remove cameras) over REST endpoints.
package camera

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
)

// Handler holds the dependencies required to handle camera-related HTTP requests.
type Handler struct {
	// service is the camera service that provides the business logic.
	service Service
}

// NewHandler creates a new Handler with the given camera service.
func NewHandler(service Service) *Handler {
	return &Handler{service: service}
}

// RegisterRoutes registers the camera-related routes on the provided router group.
//
// The following routes are registered under the "/cameras" prefix:
//   - POST   /cameras       -> AddCamera
//   - GET    /cameras       -> GetCameras
//   - DELETE /cameras/:id   -> RemoveCamera
func (h *Handler) RegisterRoutes(router *gin.RouterGroup) {
	cams := router.Group("/cameras")
	{
		cams.POST("", h.AddCamera)
		cams.GET("", h.GetCameras)
		cams.DELETE("/:id", h.RemoveCamera)
	}
}

// AddCamera handles the creation of a new camera.
//
// It binds the JSON request body to a CreateCameraDTO, assigns a tenant ID,
// and delegates the creation to the camera service.
//
// Responses:
//   - 400 Bad Request if the request body is invalid.
//   - 409 Conflict if the maximum number of cameras has been reached.
//   - 500 Internal Server Error for any other service error.
//   - 201 Created with the created camera on success.
func (h *Handler) AddCamera(c *gin.Context) {
	var dto CreateCameraDTO
	if err := c.ShouldBindJSON(&dto); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"Error": err.Error()})
		return
	}

	// ID of the local tenant assigned at the gateway.
	tenantID := "tenant-demo-123"

	cam, err := h.service.AddCamera(dto, tenantID)
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
//
// Responses:
//   - 500 Internal Server Error if the service fails to retrieve the cameras.
//   - 200 OK with the list of cameras on success.
func (h *Handler) GetCameras(c *gin.Context) {
	cameras, err := h.service.GetCameras()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"Error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, cameras)
}

// RemoveCamera handles the removal of a camera by its ID.
//
// The camera ID is extracted from the URL path parameter ":id".
//
// Responses:
//   - 400 Bad Request if the service fails to remove the camera.
//   - 200 OK with a confirmation message on success.
func (h *Handler) RemoveCamera(c *gin.Context) {
	id := c.Param("id")
	if err := h.service.RemoveCamera(id); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"Error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "Camera successfully removed."})
}
