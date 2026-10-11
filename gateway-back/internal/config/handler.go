// Package config provides the HTTP handlers for managing the gateway's
// configuration at runtime.
//
// This file implements the Gin handlers that allow reading and updating the
// configuration, including persisting changes to disk and applying them to
// the stream manager without restarting the service.
package config

import (
	"net/http"

	"gateway-back/internal/stream"

	"github.com/gin-gonic/gin"
)

// ConfigHandler holds the dependencies required to handle configuration-related
// HTTP requests.
type ConfigHandler struct {
	// cfgPath is the filesystem path to the configuration file (config.json).
	cfgPath string

	// cfg is the in-memory representation of the current configuration.
	cfg *Config

	// streamMgr is the stream manager whose cloud address is updated at runtime.
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
//
// The following routes are registered:
//   - GET /config -> GetConfig
//   - PUT /config -> UpdateConfig
func (h *ConfigHandler) RegisterRoutes(router *gin.RouterGroup) {
	router.GET("/config", h.GetConfig)
	router.PUT("/config", h.UpdateConfig)
}

// GetConfig handles the retrieval of the current configuration.
//
// Responses:
//   - 200 OK with the current configuration.
func (h *ConfigHandler) GetConfig(c *gin.Context) {
	c.JSON(http.StatusOK, h.cfg)
}

// UpdateConfig handles the update of the configuration.
//
// It binds the JSON request body to a new Config, persists it to the
// configuration file, updates the in-memory state, and applies the new cloud
// address to the stream manager at runtime.
//
// Responses:
//   - 400 Bad Request if the request body is invalid.
//   - 500 Internal Server Error if the configuration file cannot be saved.
//   - 200 OK with a confirmation message and the updated configuration on success.
func (h *ConfigHandler) UpdateConfig(c *gin.Context) {
	var newCfg Config
	if err := c.ShouldBindJSON(&newCfg); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"Error": err.Error()})
		return
	}

	// Save to the physical config.json file.
	if err := SaveConfig(h.cfgPath, &newCfg); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"Error": "Failed to save configuration file"})
		return
	}

	// Update the in-memory state.
	h.cfg.CloudAddress = newCfg.CloudAddress
	h.cfg.ServerPort = newCfg.ServerPort

	// Update the address in the StreamManager at runtime.
	h.streamMgr.UpdateCloudAddress(newCfg.CloudAddress)

	c.JSON(http.StatusOK, gin.H{
		"message": "Configuration updated successfully",
		"config":  h.cfg,
	})
}
