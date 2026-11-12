package config

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// registerMu serialises registrations (the automatic one at start-up and the UI's
// "Configure Now"), which both rewrite the shared config and config.json.
var registerMu sync.Mutex

var registerClient = &http.Client{Timeout: 10 * time.Second}

// errBackend marks a failure reaching or being refused by the main backend (HTTP 502 in the UI).
var errBackend = errors.New("main backend")

// register registers the gateway with the main backend using the given settings, then saves
// them with the tenant and gateway IDs the backend returns. Registering again with the same
// tenant and gateway name is safe: the backend returns the existing IDs.
func (h *ConfigHandler) register(p UpdateConfigPayload) error {
	registerMu.Lock()
	defer registerMu.Unlock()

	body, err := json.Marshal(map[string]string{
		"tenant_name":     p.TenantName,
		"gateway_name_id": p.GatewayNameID,
	})
	if err != nil {
		return fmt.Errorf("marshal registration payload: %w", err)
	}
	resp, err := registerClient.Post("http://"+p.BackEndAddress+"/api/gateway/add", "application/json", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("%w unreachable at %s: %v", errBackend, p.BackEndAddress, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		var e struct {
			Error string `json:"error"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&e)
		return fmt.Errorf("%w refused the registration (HTTP %d): %s", errBackend, resp.StatusCode, e.Error)
	}
	var ids BackendRegisterResponse
	if err := json.NewDecoder(resp.Body).Decode(&ids); err != nil {
		return fmt.Errorf("parse main backend response: %w", err)
	}

	h.cfg.StreamHubAddress = p.StreamHubAddress
	h.cfg.BackEndAddress = p.BackEndAddress
	h.cfg.TenantNAME = p.TenantName
	h.cfg.GatewayNameID = p.GatewayNameID
	h.cfg.TenantID = ids.TenantID
	h.cfg.GatewayID = ids.GatewayID
	h.cfg.GatewayInfoUpdated = true
	if err := SaveConfig(h.cfgPath, h.cfg); err != nil {
		return fmt.Errorf("save configuration file: %w", err)
	}
	h.streamMgr.UpdateCloudAddress(h.cfg.StreamHubAddress)
	return nil
}

// AutoRegister registers a gateway that hasn't been registered yet, using the settings it
// started with (config.json, filled from the GATEWAY_* variables), so cameras can be added
// without the one-time "Configure Now" step. It retries until the backend is up (it may start
// after the gateway). A gateway that is already registered, for example with values changed
// in the UI, is left alone. GATEWAY_AUTO_REGISTER=false turns this off.
func (h *ConfigHandler) AutoRegister(ctx context.Context) {
	if h.cfg.GatewayInfoUpdated {
		return
	}
	if v := strings.ToLower(strings.TrimSpace(os.Getenv("GATEWAY_AUTO_REGISTER"))); v == "false" || v == "0" || v == "no" {
		log.Println("auto-register: off (GATEWAY_AUTO_REGISTER=false); register on the gateway page")
		return
	}
	p := UpdateConfigPayload{
		StreamHubAddress: h.cfg.StreamHubAddress,
		BackEndAddress:   h.cfg.BackEndAddress,
		TenantName:       h.cfg.TenantNAME,
		GatewayNameID:    h.cfg.GatewayNameID,
	}
	if p.BackEndAddress == "" || p.TenantName == "" {
		log.Println("auto-register: no backend address or tenant name set; register on the gateway page")
		return
	}

	lastErr := ""
	for wait := 2 * time.Second; ; wait = min(wait*2, 30*time.Second) {
		registerMu.Lock()
		done := h.cfg.GatewayInfoUpdated // registered from the UI meanwhile
		registerMu.Unlock()
		if done {
			return
		}
		err := h.register(p)
		if err == nil {
			log.Printf("auto-register: registered as %q for tenant %q (backend %s)", p.GatewayNameID, p.TenantName, p.BackEndAddress)
			return
		}
		if err.Error() != lastErr { // log each new problem once, not every retry
			log.Printf("auto-register: %v; retrying", err)
			lastErr = err.Error()
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
	}
}
