package config

import (
	"encoding/json"
	"os"
)

type Config struct {
	CloudAddress string `json:"cloud_address"`
	ServerPort   string `json:"server_port"`
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

// SaveConfig escribe la nueva configuración en el archivo JSON
func SaveConfig(filename string, cfg *Config) error {
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	// Escribe el archivo con permisos de lectura/escritura (0644)
	return os.WriteFile(filename, data, 0644)
}
