// Package stream provides a StreamManager that coordinates multiple RTSP clients,
// relaying camera streams to a remote cloud server through FrameSenders.
package stream

import (
	"fmt"
	"log"
	"sync"

	"gateway-back/internal/network"
	"gateway-back/internal/rtsp"
)

// StreamManager coordinates multiple RTSP clients, one per camera.
//
// It maintains a registry of active RTSP clients and manages the cloud server
// address used to relay the streams. All operations are safe for concurrent use.
type StreamManager struct {
	// mu protects concurrent access to the clients map and cloudAddress field.
	mu sync.Mutex

	// clients maps a camera ID to its corresponding RTSPClient.
	clients map[string]*rtsp.RTSPClient

	// cloudAddress is the address of the remote cloud server that receives the streams.
	cloudAddress string
}

// NewStreamManager creates a new StreamManager with the given cloud server address.
//
// The clients map is initialized empty, ready to accept relay requests via StartRelay.
func NewStreamManager(cloudAddress string) *StreamManager {
	return &StreamManager{
		clients:      make(map[string]*rtsp.RTSPClient),
		cloudAddress: cloudAddress,
	}
}

// UpdateCloudAddress updates the cloud server address at runtime.
//
// Note: cameras that are already actively streaming will continue using the
// previous connection until they are restarted or StartRelay is invoked again.
func (sm *StreamManager) UpdateCloudAddress(newAddress string) {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	sm.cloudAddress = newAddress
	log.Printf("Cloud address updated to: %s", newAddress)

	// Note: cameras that are already actively streaming will continue using
	// the previous connection until they are restarted or StartRelay is invoked again.
}

// StartRelay starts relaying the stream of the given camera to the cloud server.
//
// If a client already exists for the camera ID, it is stopped and removed before
// creating a new one. It creates a FrameSender connected to the cloud address,
// then creates and starts an RTSPClient for the camera.
//
// Returns an error if the RTSP client fails to start.
func (sm *StreamManager) StartRelay(cameraID, localRTSPURL string) error {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	if client, exists := sm.clients[cameraID]; exists {
		client.Stop()
		delete(sm.clients, cameraID)
	}

	sender, err := network.NewFrameSender(sm.cloudAddress, cameraID)
	if err != nil {
		log.Printf("Could not connect to server [%s] for camera %s: %v", sm.cloudAddress, cameraID, err)
	}

	cameraClient := rtsp.NewRTSPClient(cameraID, localRTSPURL, sender)

	if err := cameraClient.Start(); err != nil {
		return fmt.Errorf("ERROR starting RTSP client for [%s]: %w", cameraID, err)
	}

	sm.clients[cameraID] = cameraClient
	return nil
}

// StopRelay stops relaying the stream of the given camera.
//
// If a client exists for the camera ID, it is stopped and removed from the
// registry. If no client exists for the given ID, this method does nothing.
func (sm *StreamManager) StopRelay(cameraID string) {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	if client, exists := sm.clients[cameraID]; exists {
		client.Stop()
		delete(sm.clients, cameraID)
	}
}
