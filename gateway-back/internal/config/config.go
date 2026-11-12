package config

import (
	"encoding/json"
	"os"
)

type Config struct {
	StreamHubAddress   string `json:"stream_hub_address"`
	BackEndAddress     string `json:"back_end_address"`
	ServerPort         string `json:"server_port"`
	TenantID           string `json:"tenant_id"`
	TenantNAME         string `json:"tenant_name"`
	GatewayNameID      string `json:"gateway_name_id"`
	GatewayID          string `json:"gateway_id"`
	GatewayInfoUpdated bool   `json:"gateway_information_updated"`

	// LegacyCloudAddress is the old name of stream_hub_address. config.json files written
	// before the rename still have it; it is read once and never written back.
	LegacyCloudAddress string `json:"cloud_address,omitempty"`
}

func LoadConfig(filename string) (*Config, error) {
	file, err := os.Open(filename)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	var cfg Config
	decoder := json.NewDecoder(file)
	if err := decoder.Decode(&cfg); err != nil {
		return nil, err
	}
	cfg.upgrade()
	return &cfg, nil
}

// upgrade fills settings an older config.json doesn't have. docker-entrypoint.sh only writes
// config.json when there is none, so a file kept in the /data volume from before a new field
// existed would otherwise leave it empty (e.g. no stream-hub address: "dial tcp: missing address").
// Missing values come from the same GATEWAY_* variables the entrypoint uses for a new file.
func (cfg *Config) upgrade() {
	if cfg.StreamHubAddress == "" {
		cfg.StreamHubAddress = cfg.LegacyCloudAddress
	}
	cfg.LegacyCloudAddress = ""
	for _, f := range []struct {
		value *string
		env   string
	}{
		{&cfg.StreamHubAddress, "GATEWAY_STREAM_HUB_ADDRESS"},
		{&cfg.BackEndAddress, "GATEWAY_BACKEND_ADDRESS"},
		{&cfg.TenantID, "GATEWAY_TENANT_ID"},
		{&cfg.TenantNAME, "GATEWAY_TENANT_NAME"},
		{&cfg.GatewayNameID, "GATEWAY_NAME_ID"},
		{&cfg.GatewayID, "GATEWAY_ID"},
	} {
		if *f.value == "" {
			*f.value = os.Getenv(f.env)
		}
	}
}

// SaveConfig writes the new configuration to the JSON file.
func SaveConfig(filename string, cfg *Config) error {
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	// Write file with read/write permissions (0644).
	return os.WriteFile(filename, data, 0644)
}
