package api

import (
	"bufio"
	"context"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

// Usage is one resource's capacity and use, in bytes.
type Usage struct {
	Total int64 `json:"total"`
	Used  int64 `json:"used"`
}

// VideoUsage is what stream-hub's incident clips take on disk, and the limits that prune them.
type VideoUsage struct {
	ClipBytes     int64   `json:"clip_bytes"`
	Clips         int     `json:"clips"`
	MaxTotalGB    float64 `json:"max_total_gb"`
	RetentionDays float64 `json:"retention_days"`
}

// Resources is the server's memory and disk, for Settings -> System status. In Docker,
// /proc/meminfo and the root filesystem are the host's (the VM's RAM; the disk that holds
// Docker's data, i.e. the database and the recordings).
type Resources struct {
	Memory *Usage      `json:"memory,omitempty"`
	Disk   *Usage      `json:"disk,omitempty"`
	Videos *VideoUsage `json:"videos,omitempty"`
}

func (s *Server) resources(ctx context.Context) Resources {
	var r Resources
	r.Memory = memoryUsage()
	r.Disk = diskUsage("/")
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	var v VideoUsage
	if err := s.hub.do(ctx, http.MethodGet, "/recordings-usage", nil, &v); err == nil {
		r.Videos = &v
	}
	return r
}

// memoryUsage reads MemTotal and MemAvailable from /proc/meminfo (Linux); nil elsewhere.
func memoryUsage() *Usage {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return nil
	}
	defer f.Close()
	kb := map[string]int64{}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) >= 2 {
			if n, err := strconv.ParseInt(fields[1], 10, 64); err == nil {
				kb[strings.TrimSuffix(fields[0], ":")] = n
			}
		}
	}
	total, ok := kb["MemTotal"]
	avail, ok2 := kb["MemAvailable"]
	if !ok || !ok2 || total == 0 {
		return nil
	}
	return &Usage{Total: total * 1024, Used: (total - avail) * 1024}
}
