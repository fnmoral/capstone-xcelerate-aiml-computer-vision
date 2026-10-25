package config

import (
	"encoding/json"
	"os"
)

// Config holds the application configuration parameters.
type Config struct {
	HTTPAddr     string `json:"http_addr"`
	TCPAddr      string `json:"tcp_addr"`
	AIServerAddr string `json:"ai_server_addr"`
	Tenant       string `json:"tenant"` // tenant used by the HTTP video routes
	MLURL        string `json:"ml_url"` // ml-service base URL (snapshots and clips)
}

// LoadConfig loads configuration from a JSON file or provides default values.
func LoadConfig(filepath string) (*Config, error) {
	file, err := os.Open(filepath)
	if err != nil {
		// Return default configuration if file is not found
		return &Config{
			HTTPAddr:     ":8080",
			TCPAddr:      ":9000",
			AIServerAddr: "127.0.0.1:9999",
			Tenant:       "demo-facility",
			MLURL:        "http://127.0.0.1:8000",
		}, nil
	}
	defer file.Close()

	decoder := json.NewDecoder(file)
	var cfg Config
	if err := decoder.Decode(&cfg); err != nil {
		return nil, err
	}

	// Apply fallbacks if fields are empty
	if cfg.HTTPAddr == "" {
		cfg.HTTPAddr = ":8080"
	}
	if cfg.TCPAddr == "" {
		cfg.TCPAddr = ":9000"
	}
	if cfg.AIServerAddr == "" {
		cfg.TCPAddr = "127.0.0.1:9999"
	}
	if cfg.MLURL == "" {
		cfg.MLURL = "http://127.0.0.1:8000"
	}
	if cfg.Tenant == "" {
		cfg.Tenant = "demo-facility"
	}

	return &cfg, nil
}
