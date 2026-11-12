package config

import (
	"encoding/json"
	"errors"
	"os"

	"stream-hub/internal/recording"
)

// Config holds the application configuration parameters.
type Config struct {
	HTTPAddr     string           `json:"http_addr"`
	TCPAddr      string           `json:"tcp_addr"`
	AIServerAddr string           `json:"ai_server_addr"`
	Tenant       string           `json:"tenant"` // tenant used by the HTTP video routes
	Recordings   recording.Config `json:"recordings"`
}

// LoadConfig loads configuration from a JSON file; missing file or fields get defaults.
func LoadConfig(filepath string) (*Config, error) {
	var cfg Config
	file, err := os.Open(filepath)
	switch {
	case errors.Is(err, os.ErrNotExist):
		// no config file: defaults only
	case err != nil:
		return nil, err
	default:
		defer file.Close()
		if err := json.NewDecoder(file).Decode(&cfg); err != nil {
			return nil, err
		}
	}

	if cfg.HTTPAddr == "" {
		cfg.HTTPAddr = ":8080"
	}
	if cfg.TCPAddr == "" {
		cfg.TCPAddr = ":9000"
	}
	if cfg.AIServerAddr == "" {
		cfg.AIServerAddr = "127.0.0.1:9999"
	}
	if cfg.Tenant == "" {
		cfg.Tenant = "demo-facility"
	}
	cfg.Recordings = cfg.Recordings.WithDefaults()

	return &cfg, nil
}
