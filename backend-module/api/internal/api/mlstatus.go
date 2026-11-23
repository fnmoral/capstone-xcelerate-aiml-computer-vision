package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"
)

const (
	// ml-service rewrites its status every 10 s; older than this means it is down.
	mlStatusStale = 30 * time.Second
	// People shown on a camera: ml-service's predictions from this recent.
	peopleWindow = 3 * time.Second
)

var errMLNoStatus = errors.New("ml-service has not reported its status yet (is it running?)")

// mlStatusCamera is one camera in ml-service's status (detection_settings().analysis).
type mlStatusCamera struct {
	CameraID      string   `json:"camera_id"`
	LastFrameAgeS *float64 `json:"last_frame_age_s"`
}

// mlFrameAges returns, per camera ml-service is analysing, how many seconds ago it
// analysed its last frame. Errors when ml-service has stopped reporting.
// videoAges asks stream-hub how many seconds ago each camera's last frame arrived (empty if
// stream-hub doesn't answer).
func (s *Server) videoAges(ctx context.Context) map[string]float64 {
	var out struct {
		Cameras map[string]float64 `json:"cameras"`
	}
	if err := s.hub.do(ctx, http.MethodGet, "/video-status", nil, &out); err != nil || out.Cameras == nil {
		return map[string]float64{}
	}
	return out.Cameras
}

func (s *Server) mlFrameAges(ctx context.Context) (map[string]float64, error) {
	st, err := s.db.MLStatus(ctx)
	if err != nil {
		return nil, err
	}
	if st == nil {
		return nil, errMLNoStatus
	}
	since := time.Since(st.UpdatedAt)
	if since > mlStatusStale {
		return nil, fmt.Errorf("ml-service has not reported for %s", since.Round(time.Second))
	}
	var payload struct {
		Analysis struct {
			Cameras []mlStatusCamera `json:"cameras"`
		} `json:"analysis"`
	}
	if err := json.Unmarshal(st.Payload, &payload); err != nil {
		return nil, fmt.Errorf("ml_status: %w", err)
	}
	out := make(map[string]float64, len(payload.Analysis.Cameras))
	for _, c := range payload.Analysis.Cameras {
		if c.LastFrameAgeS != nil { // age when reported + time since the report
			out[c.CameraID] = *c.LastFrameAgeS + since.Seconds()
		}
	}
	return out, nil
}
