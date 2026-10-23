// Package camera provides the domain service and business logic for managing
// cameras within a gateway, including creation, listing, removal, and stream
// restoration.
package camera

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/url"
	"sync"
	"time"

	"github.com/google/uuid"

	"gateway-back/internal/rtsp"
	"gateway-back/internal/stream"
)

// Per gateway: at most MaxStreaming cameras stream at once; up to MaxSaved are kept, the
// rest paused ("standby"). A paused camera costs nothing (no connection, no video), so
// cameras can be switched with pause / resume instead of being removed and added again.
const (
	MaxStreaming = 5
	MaxSaved     = 50
)

// ErrMaxCamerasReached is returned when adding a camera beyond MaxSaved.
var ErrMaxCamerasReached = fmt.Errorf("Limit reached: up to %d cameras can be saved per gateway.", MaxSaved)

// ErrMaxStreaming is returned when resuming a camera while MaxStreaming are streaming.
var ErrMaxStreaming = fmt.Errorf("%d cameras are already streaming on this gateway: pause one first.", MaxStreaming)

// ErrCameraNotFound is returned when no camera has the given ID.
var ErrCameraNotFound = errors.New("Camera not found.")

// Camera statuses.
const (
	StatusOnline = "online"
	StatusPaused = "paused" // stream stopped by the user; not restarted on gateway start
)

// Service defines the business logic operations for managing cameras.
type Service interface {
	// AddCamera creates a new camera, persists it, and starts its stream relay.
	AddCamera(dto CreateCameraDTO, tenantID string) (*Camera, error)

	// GetCameras returns all cameras stored in the repository.
	GetCameras() ([]Camera, error)

	// RemoveCamera stops the stream relay and deletes the camera by its ID.
	RemoveCamera(id string) error

	// PauseCamera stops the camera's stream relay and marks it paused, so it stays
	// stopped across gateway restarts until resumed.
	PauseCamera(id string) (*Camera, error)

	// ResumeCamera restarts a paused camera's stream relay and marks it online.
	ResumeCamera(id string) (*Camera, error)

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

	// mu makes "count the streaming cameras, then start one" atomic, so two requests at
	// once can't go over MaxStreaming.
	mu sync.Mutex
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
// Up to MaxSaved cameras are kept (else ErrMaxCamerasReached). While MaxStreaming are
// already streaming, a new camera is saved paused (standby) and not started.
//
// If the camera is saved successfully but the stream relay fails to start,
// the camera is still persisted and a warning is logged instead of returning
// an error.
func (s *service) AddCamera(dto CreateCameraDTO, tenantID string) (*Camera, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	count, err := s.repo.Count()
	if err != nil {
		return nil, fmt.Errorf("ERROR checking total number of cameras: %w", err)
	}
	if count >= MaxSaved {
		return nil, ErrMaxCamerasReached
	}
	streaming, err := s.repo.CountStreaming()
	if err != nil {
		return nil, fmt.Errorf("ERROR checking streaming cameras: %w", err)
	}
	status := StatusOnline
	if streaming >= MaxStreaming {
		status = StatusPaused
	}

	now := time.Now()
	cam := &Camera{
		ID:        uuid.New().String(),
		TenantID:  tenantID,
		Name:      dto.Name,
		RTSPURL:   dto.RTSPURL,
		Username:  dto.Username,
		Password:  dto.Password,
		Status:    status,
		CreatedAt: now,
		UpdatedAt: now,
	}

	if err := s.repo.Create(cam); err != nil {
		return nil, fmt.Errorf("ERROR saving camera: %w", err)
	}
	if status == StatusPaused {
		log.Printf("Camera [%s] (%s) saved on standby: %d cameras already streaming", cam.ID, cam.Name, streaming)
		return cam, nil
	}

	fullRTSPURL := buildRTSPURL(cam.RTSPURL, cam.Username, cam.Password)

	err = s.streamManager.StartRelay(cam.ID, cam.TenantID, fullRTSPURL)
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

// PauseCamera stops the stream relay for the camera and stores the paused status.
// Downstream, stream-hub and ml-service see the camera disconnect.
func (s *service) PauseCamera(id string) (*Camera, error) {
	cam, err := s.repo.FindByID(id)
	if err != nil {
		return nil, err
	}
	if cam == nil {
		return nil, ErrCameraNotFound
	}
	s.streamManager.StopRelay(id)
	if err := s.repo.UpdateStatus(id, StatusPaused); err != nil {
		return nil, err
	}
	cam.Status = StatusPaused
	log.Printf("Camera [%s] (%s) paused", cam.ID, cam.Name)
	return cam, nil
}

// ResumeCamera starts the stream relay again and stores the online status.
func (s *service) ResumeCamera(id string) (*Camera, error) {
	cam, err := s.repo.FindByID(id)
	if err != nil {
		return nil, err
	}
	if cam == nil {
		return nil, ErrCameraNotFound
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if cam.Status != StatusPaused {
		return cam, nil // already streaming
	}
	if streaming, err := s.repo.CountStreaming(); err != nil {
		return nil, err
	} else if streaming >= MaxStreaming {
		return nil, ErrMaxStreaming
	}
	fullURL := buildRTSPURL(cam.RTSPURL, cam.Username, cam.Password)
	if err := s.streamManager.StartRelay(cam.ID, cam.TenantID, fullURL); err != nil {
		return nil, fmt.Errorf("ERROR resuming stream: %w", err)
	}
	if err := s.repo.UpdateStatus(id, StatusOnline); err != nil {
		return nil, err
	}
	cam.Status = StatusOnline
	log.Printf("Camera [%s] (%s) resumed", cam.ID, cam.Name)
	return cam, nil
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
		if cam.Status == StatusPaused {
			continue
		}
		fullURL := buildRTSPURL(cam.RTSPURL, cam.Username, cam.Password)
		if err := s.streamManager.StartRelay(cam.ID, cam.TenantID, fullURL); err != nil {
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
// buildRTSPURL adds the camera's username and password to its RTSP URL, escaped so
// passwords with @ : / # ? still work. A URL that already carries credentials, or a
// camera without a username, is used as is.
func buildRTSPURL(rawURL, username, password string) string {
	u, err := url.Parse(rawURL)
	if err != nil || username == "" || u.User != nil {
		return rawURL
	}
	u.User = url.UserPassword(username, password)
	return u.String()
}

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
		if cam.Status == StatusPaused {
			log.Printf("Camera [%s] (%s) is paused; not restoring its stream", cam.ID, cam.Name)
			continue
		}
		// Launch each stream in its own goroutine.
		go func(c Camera) {
			log.Printf("Restoring relay for camera [%s] (%s) -> URL: %s", c.ID, c.Name, rtsp.Redact(c.RTSPURL))
			// With the camera's login, as when it was added (cameras that need one got 401
			// after every gateway restart without it).
			if err := s.streamManager.StartRelay(c.ID, c.TenantID, buildRTSPURL(c.RTSPURL, c.Username, c.Password)); err != nil {
				log.Printf("ERROR restoring relay for camera [%s]: %v", c.ID, err)
			}
		}(cam)
	}

	return nil
}
