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

	return &cfg, nil
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
