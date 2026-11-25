//go:build !linux && !darwin

package api

// diskUsage is not measured outside Linux and macOS (the API runs in a Linux container).
func diskUsage(string) *Usage { return nil }
