// Package camera provides the domain service and business logic for managing
// cameras within a gateway, including creation, listing, removal, and stream
// restoration.
package camera

import (
	"context"
	"errors"
	"fmt"
	"log"
	"time"

	"github.com/google/uuid"

	"gateway-back/internal/stream"
)

// ErrMaxCamerasReached is returned when an attempt is made to add a camera
// beyond the maximum allowed limit of three cameras per gateway.
var ErrMaxCamerasReached = errors.New("Limit reached: Only up to 3 cameras are allowed per gateway.")

// Service defines the business logic operations for managing cameras.
type Service interface {
	// AddCamera creates a new camera, persists it, and starts its stream relay.
	AddCamera(dto CreateCameraDTO, tenantID string) (*Camera, error)

	// GetCameras returns all cameras stored in the repository.
	GetCameras() ([]Camera, error)

	// RemoveCamera stops the stream relay and deletes the camera by its ID.
	RemoveCamera(id string) error

	// InitStreams starts the stream relay for all cameras stored in the repository.
	InitStreams() error

	// RestoreSavedStreams restores the stream relay for all previously saved cameras.
	RestoreSavedStreams(ctx context.Context) error
}

// service is the concrete implementation of the Service interface.
type service struct {
	// repo is the repository used for persisting and retrieving cameras.
	repo Repository

	// streamManager coordinates the RTSP stream relays for the cameras.
	streamManager *stream.StreamManager
}

// NewService creates a new camera Service with the given repository and stream manager.
//
// Note: this constructor no longer receives the cloudIngest string.
func NewService(repo Repository, sm *stream.StreamManager) Service {
	return &service{
		repo:          repo,
		streamManager: sm,
	}
}

// AddCamera creates a new camera with the provided data, persists it, and
// starts its stream relay.
//
// It enforces a maximum of three cameras per gateway. If the limit has been
// reached, it returns ErrMaxCamerasReached.
//
// If the camera is saved successfully but the stream relay fails to start,
// the camera is still persisted and a warning is logged instead of returning
// an error.
func (s *service) AddCamera(dto CreateCameraDTO, tenantID string) (*Camera, error) {
	count, err := s.repo.Count()
	if err != nil {
		return nil, fmt.Errorf("ERROR checking total number of cameras: %w", err)
	}

	if count >= 3 {
		return nil, ErrMaxCamerasReached
	}

	now := time.Now()
	cam := &Camera{
		ID:        uuid.New().String(),
		TenantID:  tenantID,
		Name:      dto.Name,
		RTSPURL:   dto.RTSPURL,
		Username:  dto.Username,
		Password:  dto.Password,
		Status:    "online",
		CreatedAt: now,
		UpdatedAt: now,
	}

	if err := s.repo.Create(cam); err != nil {
		return nil, fmt.Errorf("ERROR saving camera: %w", err)
	}

	fullRTSPURL := buildRTSPURL(cam.RTSPURL, cam.Username, cam.Password)

	err = s.streamManager.StartRelay(cam.ID, fullRTSPURL)
	if err != nil {
		log.Printf("WARNING: Camera was saved but stream initialization failed: %v", err)
	}

	return cam, nil
}

// GetCameras returns all cameras stored in the repository.
func (s *service) GetCameras() ([]Camera, error) {
	return s.repo.FindAll()
}

// RemoveCamera stops the stream relay for the given camera ID and deletes the
// camera from the repository.
func (s *service) RemoveCamera(id string) error {
	s.streamManager.StopRelay(id)
	return s.repo.Delete(id)
}

// InitStreams retrieves all cameras from the repository and starts the stream
// relay for each of them.
//
// If starting a relay fails for a specific camera, the error is logged and the
// loop continues with the next camera.
func (s *service) InitStreams() error {
	cameras, err := s.repo.FindAll()
	if err != nil {
		return err
	}

	for _, cam := range cameras {
		fullURL := buildRTSPURL(cam.RTSPURL, cam.Username, cam.Password)
		if err := s.streamManager.StartRelay(cam.ID, fullURL); err != nil {
			log.Printf("ERROR restoring stream for camera %s: %v", cam.Name, err)
		}
	}
	return nil
}

// buildRTSPURL constructs the full RTSP URL from the raw URL and credentials.
//
// Currently, it only logs the received URL and returns it unchanged. The
// commented-out implementation above shows the previous behavior, which
// injected the username and password into the URL.
func buildRTSPURL(rawURL, username, password string) string {
	log.Printf("RTSP received: %q", rawURL)
	return rawURL
}

// func buildRTSPURL(rawURL, username, password string) string {
// 	if username == "" || password == "" {
// 		return rawURL
// 	}

// 	// If the URL starts with rtsp://, we inject username:password@ right after
// 	if len(rawURL) > 7 && rawURL[:7] == "rtsp://" {
// 		return fmt.Sprintf("rtsp://%s:%s@%s", username, password, rawURL[7:])
// 	}

// 	return rawURL
// }

// RestoreSavedStreams restores the stream relay for all cameras previously
// saved in the repository.
//
// If no cameras are found, it logs a message and returns nil. Otherwise, it
// launches each stream relay in its own goroutine so that they run concurrently.
//
// Note: because goroutines are used, errors encountered while starting a relay
// are logged but not returned to the caller.
func (s *service) RestoreSavedStreams(ctx context.Context) error {
	cameras, err := s.repo.FindAll()
	if err != nil {
		return err
	}

	if len(cameras) == 0 {
		log.Println("No previously registered cameras found in the database.")
		return nil
	}

	log.Printf("Restoring connection for %d stored camera(s)...", len(cameras))

	for _, cam := range cameras {
		// Launch each stream in its own goroutine.
		go func(c Camera) {
			log.Printf("Restoring relay for camera [%s] (%s) -> URL: %s", c.ID, c.Name, c.RTSPURL)
			if err := s.streamManager.StartRelay(c.ID, c.RTSPURL); err != nil {
				log.Printf("ERROR restoring relay for camera [%s]: %v", c.ID, err)
			}
		}(cam)
	}

	return nil
}
