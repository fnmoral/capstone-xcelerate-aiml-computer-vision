package api

import (
	"context"
	"fmt"
	"log"
	"time"

	"backend-api/internal/store"
)

const (
	monitorInterval = 5 * time.Second
	// A camera on the gateway (not paused) whose video hasn't reached ml-service for this
	// long is "not working". Long enough to ride out a camera or ml-service restart.
	notWorkingAfter = 20 * time.Second
)

// Database camera status → health shown in the UI and logged as "camera.<health>".
var healthOf = map[string]string{
	"online":   "online",
	"disabled": "paused",
	"error":    "not_working",
	"offline":  "not_connected",
}

// WatchCameras keeps cameras.status in step with reality and logs every change to
// system_logs: paused / resumed (also from the gateway UI), video stopped arriving,
// video back, no longer on the gateway. Runs until ctx is cancelled.
func (s *Server) WatchCameras(ctx context.Context) {
	noVideoSince := map[string]time.Time{}
	var lastErr string
	t := time.NewTicker(monitorInterval)
	defer t.Stop()
	for {
		if err := s.checkCameras(ctx, noVideoSince); err != nil && err.Error() != lastErr {
			log.Printf("camera monitor: %v", err)
			lastErr = err.Error()
		} else if err == nil {
			lastErr = ""
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (s *Server) checkCameras(ctx context.Context, noVideoSince map[string]time.Time) error {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	st, err := s.gatewayState(ctx)
	if err != nil {
		return err
	}
	s.resumeSwitchPaused(ctx, st)
	gw, err := st.client(s).cameras(ctx) // the gateway in use
	if err != nil {
		return err // can't tell paused from broken without the gateway; try again next tick
	}
	dbCams, err := s.db.Cameras(ctx)
	if err != nil {
		return err
	}
	// ml-service down (stopped reporting its status): nothing is being analysed, so its
	// cameras count as not working once the grace period has passed.
	frameAge, mlErr := s.mlFrameAges(ctx)
	videoAge := s.videoAges(ctx) // video reaching stream-hub: the camera itself works

	now := time.Now()
	onGateway := map[string]bool{}
	for _, g := range gw {
		onGateway[g.ID] = true
		var want string
		switch age, ok := frameAge[g.ID]; {
		case g.Status == "paused":
			want = "disabled"
			delete(noVideoSince, g.ID)
		case mlErr == nil && ok && age < notWorkingAfter.Seconds():
			want = "online"
			delete(noVideoSince, g.ID)
		case videoAge[g.ID] > 0 && videoAge[g.ID] < notWorkingAfter.Seconds():
			want = "online" // video arrives; only the detector isn't analysing it (health "video_only")
			delete(noVideoSince, g.ID)
		default:
			first, seen := noVideoSince[g.ID]
			if !seen {
				noVideoSince[g.ID] = now
				continue
			}
			if now.Sub(first) < notWorkingAfter {
				continue
			}
			want = "error"
		}
		s.applyStatus(ctx, g.ID, g.Name, want, mlErr, "")
	}
	for _, d := range dbCams {
		if !onGateway[d.ID] {
			delete(noVideoSince, d.ID)
			msg := ""
			if d.GatewayID != nil && st.inUse != nil && *d.GatewayID != st.inUse.ID {
				if g := st.find(*d.GatewayID); g != nil {
					msg = "On another gateway (" + g.DisplayName + "), not in use"
				}
			}
			s.applyStatus(ctx, d.ID, d.Name, "offline", nil, msg)
		}
	}
	return nil
}

// resumeSwitchPaused resumes the cameras paused by a gateway switch once their gateway is in
// use and answers again, also when Automatic switched back to it (e.g. the laptop came back).
func (s *Server) resumeSwitchPaused(ctx context.Context, st gatewayState) {
	if st.inUse == nil || !st.online[st.inUse.ID] {
		return
	}
	ids, err := s.db.SwitchPausedIDs(ctx, st.inUse.ID)
	if err != nil || len(ids) == 0 {
		return
	}
	var resumed []string
	for _, id := range ids {
		if _, err := st.client(s).camera(ctx, "resume", id); err != nil {
			log.Printf("camera monitor: resuming %s: %v", id, err)
			continue
		}
		resumed = append(resumed, id)
	}
	if err := s.db.MarkSwitchPaused(ctx, resumed, false); err != nil {
		log.Printf("camera monitor: %v", err)
	}
}

// applyStatus stores the status and, if it changed, logs it with a readable message
// (offlineMsg replaces the default "Not connected to a gateway").
func (s *Server) applyStatus(ctx context.Context, id, name, want string, mlErr error, offlineMsg string) {
	from, changed, err := s.db.SetCameraStatus(ctx, id, want)
	if err != nil {
		log.Printf("camera monitor: %s: %v", id, err)
		return
	}
	if !changed {
		return
	}
	level, msg := "info", ""
	switch want {
	case "online":
		msg = map[string]string{"error": "Video is back", "disabled": "Resumed from the gateway",
			"offline": "Connected to the gateway"}[from]
		if msg == "" {
			msg = "Online"
		}
	case "disabled":
		msg = "Paused from the gateway"
	case "error":
		level, msg = "warning", fmt.Sprintf("Not working: no video for %d seconds", int(notWorkingAfter.Seconds()))
		if mlErr != nil {
			msg = "Not working: the detector (ml-service) is not running"
		}
	case "offline":
		level, msg = "warning", "Not connected to a gateway"
		if offlineMsg != "" {
			level, msg = "info", offlineMsg
		}
	}
	if err := s.db.CameraEvent(ctx, id, name, healthOf[want], level, msg); err != nil {
		log.Printf("camera monitor: logging %s: %v", id, err)
	}
	log.Printf("camera %s (%s): %s", name, id, msg)
}

// cameraHealth is what the UI shows for a camera right now.
func cameraHealth(v CameraView, d *store.Camera) string {
	switch {
	case !v.OnGateway:
		return "not_connected"
	case v.Status == "paused":
		return "paused"
	case v.Live:
		return "online"
	case v.Video:
		return "video_only" // video arrives, but the detector isn't analysing it
	case d != nil && d.Status == "error":
		return "not_working"
	default:
		return "connecting" // just added or resumed, video not here yet
	}
}
