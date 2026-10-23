package api

import (
	"context"
	"log"
	"time"
)

// The PC's webcam, published into the test-camera relay by ml-service/tools/publish_webcam.py.
const (
	devWebcamName = "Windows webcam"
	devWebcamURL  = "rtsp://test-camera:8554/webcam"
)

// DevWebcam runs in dev mode (PROD_MODE=false): if the gateway has no cameras at all, it
// adds the PC's webcam, so a fresh dev stack has live video as soon as the publisher runs.
// A camera removed later isn't added back, because the gateway then still has others, or
// was emptied on purpose after this ran once.
func (s *Server) DevWebcam(ctx context.Context) {
	for wait := time.Duration(0); wait < 3*time.Minute; wait += 5 * time.Second {
		select {
		case <-ctx.Done():
			return
		case <-time.After(5 * time.Second): // the gateway may still be starting
		}
		cams, err := s.gateway.cameras(ctx)
		if err != nil {
			continue
		}
		if len(cams) > 0 {
			return
		}
		cam, err := s.gateway.addCamera(ctx, devWebcamName, devWebcamURL, "", "")
		if err != nil {
			log.Printf("dev mode: adding the webcam camera: %v", err)
			return
		}
		location := "This PC"
		if err := s.db.UpsertCamera(ctx, cam.ID, devWebcamName, devWebcamURL, dbStatus(cam.Status), &location, nil); err != nil {
			log.Printf("dev mode: registering the webcam camera: %v", err)
			return
		}
		if err := s.db.CameraEvent(ctx, cam.ID, devWebcamName, "added", "info",
			"Added automatically (dev mode): this PC's webcam through the test-camera relay"); err != nil {
			log.Printf("dev mode: logging the webcam camera: %v", err)
		}
		log.Printf("dev mode: added camera %q (%s); start ml-service/tools/publish_webcam.py on the PC for video", devWebcamName, devWebcamURL)
		return
	}
	log.Printf("dev mode: gateway not reachable; webcam camera not added")
}
