package config

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"gateway-back/internal/stream"
)

// fakeBackend answers /api/gateway/add like the main backend, failing the first `fail` calls
// (as if it were still starting).
func fakeBackend(t *testing.T, fail int32) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := calls.Add(1)
		if r.URL.Path != "/api/gateway/add" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		if n <= fail {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		var req map[string]string
		_ = json.NewDecoder(r.Body).Decode(&req)
		if req["tenant_name"] != "demo-facility" || req["gateway_name_id"] != "default_gateway" {
			t.Errorf("unexpected registration %v", req)
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"tenant_id": "tenant-uuid", "gateway_id": "gateway-uuid"})
	}))
	t.Cleanup(srv.Close)
	return srv, &calls
}

func newHandler(t *testing.T, backend string, registered bool) (*ConfigHandler, string) {
	t.Helper()
	path := write(t, `{}`)
	cfg := &Config{
		StreamHubAddress:   "stream-hub:8090",
		BackEndAddress:     strings.TrimPrefix(backend, "http://"),
		TenantNAME:         "demo-facility",
		TenantID:           "demo-facility",
		GatewayNameID:      "default_gateway",
		GatewayID:          "default_id",
		GatewayInfoUpdated: registered,
	}
	return NewConfigHandler(path, cfg, stream.NewStreamManager(cfg.StreamHubAddress)), path
}

// A new gateway registers by itself, waiting for a backend that isn't ready yet, and saves the IDs.
func TestAutoRegisterRetriesUntilBackendIsUp(t *testing.T) {
	srv, calls := fakeBackend(t, 1)
	h, path := newHandler(t, srv.URL, false)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	h.AutoRegister(ctx)

	if calls.Load() != 2 {
		t.Fatalf("backend called %d times, want 2 (one failure, one success)", calls.Load())
	}
	saved, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if !saved.GatewayInfoUpdated || saved.TenantID != "tenant-uuid" || saved.GatewayID != "gateway-uuid" {
		t.Fatalf("saved config not registered: %+v", saved)
	}
}

// A gateway that is already registered (e.g. edited in the UI) is left alone.
func TestAutoRegisterSkipsRegisteredGateway(t *testing.T) {
	srv, calls := fakeBackend(t, 0)
	h, _ := newHandler(t, srv.URL, true)
	h.AutoRegister(context.Background())
	if calls.Load() != 0 {
		t.Fatalf("backend called %d times, want 0", calls.Load())
	}
}

// GATEWAY_AUTO_REGISTER=false keeps the manual "Configure Now" step.
func TestAutoRegisterCanBeTurnedOff(t *testing.T) {
	t.Setenv("GATEWAY_AUTO_REGISTER", "false")
	srv, calls := fakeBackend(t, 0)
	h, _ := newHandler(t, srv.URL, false)
	h.AutoRegister(context.Background())
	if calls.Load() != 0 || h.cfg.GatewayInfoUpdated {
		t.Fatalf("registered although turned off")
	}
}
