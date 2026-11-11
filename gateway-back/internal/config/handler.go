// Package config provides the HTTP handlers for managing the gateway's
// configuration at runtime.
package config

import (
	"errors"
	"net/http"

	"gateway-back/internal/stream"

	"github.com/gin-gonic/gin"
)

// ConfigHandler holds the dependencies required to handle configuration-related
// HTTP requests.
type ConfigHandler struct {
	cfgPath   string
	cfg       *Config
	streamMgr *stream.StreamManager
}

// NewConfigHandler creates a new ConfigHandler with the given configuration
// path, in-memory configuration, and stream manager.
func NewConfigHandler(cfgPath string, cfg *Config, streamMgr *stream.StreamManager) *ConfigHandler {
	return &ConfigHandler{
		cfgPath:   cfgPath,
		cfg:       cfg,
		streamMgr: streamMgr,
	}
}

// RegisterRoutes registers the configuration-related routes on the provided
// router group.
func (h *ConfigHandler) RegisterRoutes(router *gin.RouterGroup) {
	router.GET("/config", h.GetConfig)
	router.PUT("/config", h.UpdateConfig)
}

// GetConfig handles the retrieval of the current configuration.
func (h *ConfigHandler) GetConfig(c *gin.Context) {
	c.JSON(http.StatusOK, h.cfg)
}

// UpdateConfigPayload defines the expected payload from the frontend.
type UpdateConfigPayload struct {
	StreamHubAddress string `json:"stream_hub_address"`
	BackEndAddress   string `json:"back_end_address"`
	TenantName       string `json:"tenant_name"`
	GatewayNameID    string `json:"gateway_name_id"`
}

// BackendRegisterResponse defines the expected response structure from the main backend.
type BackendRegisterResponse struct {
	TenantID  string `json:"tenant_id"`
	GatewayID string `json:"gateway_id"`
}

// UpdateConfig handles the update of the configuration, registers the gateway
// to the main backend, and updates the local state.
func (h *ConfigHandler) UpdateConfig(c *gin.Context) {
	var payload UpdateConfigPayload
	if err := c.ShouldBindJSON(&payload); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"Error": err.Error()})
		return
	}

	// Register (or re-register with changed values) on the main backend, then save.
	// The gateway also does this by itself at start-up (AutoRegister); this lets a user change
	// the values later from the gateway page.
	if err := h.register(payload); err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, errBackend) {
			status = http.StatusBadGateway
		}
		c.JSON(status, gin.H{"Error": "Failed to register the gateway: " + err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"message": "Configuration updated successfully",
		"config":  h.cfg,
	})
}
