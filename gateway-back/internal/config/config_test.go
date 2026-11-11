package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func write(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// A config.json from before the rename (cloud_address, no back_end_address) still works.
func TestLoadConfigUpgradesOldFile(t *testing.T) {
	t.Setenv("GATEWAY_BACKEND_ADDRESS", "api:8000")
	t.Setenv("GATEWAY_STREAM_HUB_ADDRESS", "should-not-win:1")
	path := write(t, `{"cloud_address": "stream-hub:8090", "server_port": ":8080", "tenant_id": "demo-facility"}`)

	cfg, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.StreamHubAddress != "stream-hub:8090" {
		t.Errorf("StreamHubAddress = %q, want the old cloud_address", cfg.StreamHubAddress)
	}
	if cfg.BackEndAddress != "api:8000" {
		t.Errorf("BackEndAddress = %q, want it from GATEWAY_BACKEND_ADDRESS", cfg.BackEndAddress)
	}

	// Saving writes the new name only.
	if err := SaveConfig(path, cfg); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	if strings.Contains(string(data), "cloud_address") || !strings.Contains(string(data), `"stream_hub_address": "stream-hub:8090"`) {
		t.Errorf("saved config = %s", data)
	}
}

// Values already in config.json (e.g. set in the gateway UI) are never replaced.
func TestLoadConfigKeepsSavedValues(t *testing.T) {
	t.Setenv("GATEWAY_STREAM_HUB_ADDRESS", "stream-hub:8090")
	path := write(t, `{"stream_hub_address": "10.0.0.5:8090", "back_end_address": "10.0.0.5:8000"}`)

	cfg, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.StreamHubAddress != "10.0.0.5:8090" || cfg.BackEndAddress != "10.0.0.5:8000" {
		t.Errorf("saved values replaced: %+v", cfg)
	}
}
