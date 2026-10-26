// Package config provides the HTTP handlers for managing the gateway's
// configuration at runtime.
package config

import (
	"bytes"
	"encoding/json"
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

	// Prepare payload to register the gateway on the main backend.
	// Sends tenant_name (slug) and gateway_name_id as required by the backend.
	registerBody, err := json.Marshal(gin.H{
		"tenant_name":     payload.TenantName,
		"gateway_name_id": payload.GatewayNameID,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"Error": "Failed to marshal registration payload"})
		return
	}

	// Perform POST request to the main backend to register/update the gateway.
	resp, err := http.Post("http://"+payload.BackEndAddress+"/api/gateway/add", "application/json", bytes.NewBuffer(registerBody))
	if err != nil || (resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated) {
		c.JSON(http.StatusBadGateway, gin.H{"Error": "Failed to communicate with the main backend or tenant not found"})
		return
	}
	defer resp.Body.Close()

	// Decode the response from the backend to obtain the assigned tenant_id.
	var backendResp BackendRegisterResponse
	if err := json.NewDecoder(resp.Body).Decode(&backendResp); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"Error": "Failed to parse main backend response"})
		return
	}

	// Update in-memory configuration state.
	h.cfg.StreamHubAddress = payload.StreamHubAddress
	h.cfg.BackEndAddress = payload.BackEndAddress
	h.cfg.TenantNAME = payload.TenantName
	h.cfg.GatewayNameID = payload.GatewayNameID
	h.cfg.TenantID = backendResp.TenantID
	h.cfg.GatewayID = backendResp.GatewayID
	h.cfg.GatewayInfoUpdated = true

	// Save changes to the physical configuration file.
	if err := SaveConfig(h.cfgPath, h.cfg); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"Error": "Failed to save configuration file"})
		return
	}

	// Update the address in the StreamManager at runtime.
	h.streamMgr.UpdateCloudAddress(h.cfg.StreamHubAddress)

	c.JSON(http.StatusOK, gin.H{
		"message": "Configuration updated successfully",
		"config":  h.cfg,
	})
}
