package hub

import (
	"sync"
)

// StreamBroker manages streams grouped by tenant and camera for both clients and AI workers.
type StreamBroker struct {
	mu          sync.RWMutex
	subscribers map[string]map[string][]*Client   // tenantID -> cameraID -> list of frontend clients
	aiWorkers   map[string]map[string][]*AIWorker // tenantID -> cameraID -> list of AI workers
}

// NewStreamBroker creates a new instance of StreamBroker.
func NewStreamBroker() *StreamBroker {
	return &StreamBroker{
		subscribers: make(map[string]map[string][]*Client),
		aiWorkers:   make(map[string]map[string][]*AIWorker),
	}
}

// RegisterClient adds a frontend subscriber to a specific tenant and camera stream.
func (b *StreamBroker) RegisterClient(tenantID, cameraID string, client *Client) {
	b.mu.Lock()
	defer b.mu.Unlock()

	if _, exists := b.subscribers[tenantID]; !exists {
		b.subscribers[tenantID] = make(map[string][]*Client)
	}

	b.subscribers[tenantID][cameraID] = append(b.subscribers[tenantID][cameraID], client)
}

// UnregisterClient removes a frontend subscriber.
func (b *StreamBroker) UnregisterClient(tenantID, cameraID string, client *Client) {
	b.mu.Lock()
	defer b.mu.Unlock()

	clients, exists := b.subscribers[tenantID][cameraID]
	if !exists {
		return
	}

	for i, c := range clients {
		if c.ID == client.ID {
			b.subscribers[tenantID][cameraID] = append(clients[:i], clients[i+1:]...)
			close(client.SendChan)
			break
		}
	}
}

// RegisterAIWorker adds an AI worker consumer to a specific tenant and camera stream.
func (b *StreamBroker) RegisterAIWorker(tenantID, cameraID string, worker *AIWorker) {
	b.mu.Lock()
	defer b.mu.Unlock()

	if _, exists := b.aiWorkers[tenantID]; !exists {
		b.aiWorkers[tenantID] = make(map[string][]*AIWorker)
	}

	b.aiWorkers[tenantID][cameraID] = append(b.aiWorkers[tenantID][cameraID], worker)
}

// UnregisterAIWorker removes an AI worker consumer.
func (b *StreamBroker) UnregisterAIWorker(tenantID, cameraID string, worker *AIWorker) {
	b.mu.Lock()
	defer b.mu.Unlock()

	workers, exists := b.aiWorkers[tenantID][cameraID]
	if !exists {
		return
	}

	for i, w := range workers {
		if w == worker {
			b.aiWorkers[tenantID][cameraID] = append(workers[:i], workers[i+1:]...)
			close(worker.InputChan)
			break
		}
	}
}

// BroadcastFrame distributes frame data to all frontend subscribers and AI workers listening to a specific tenant and camera.
func (b *StreamBroker) BroadcastFrame(tenantID, cameraID string, frame []byte) {
	b.mu.RLock()
	defer b.mu.RUnlock()

	// 1. Broadcast to Frontend WebSocket clients
	if clients, exists := b.subscribers[tenantID][cameraID]; exists {
		for _, client := range clients {
			select {
			case client.SendChan <- frame:
			default:
				// Skip if client buffer is full to prevent blocking ingestion
			}
		}
	}

	// 2. Send to AI workers (throttled by their individual tickers)
	if workers, exists := b.aiWorkers[tenantID][cameraID]; exists {
		for _, worker := range workers {
			select {
			case worker.InputChan <- frame:
			default:
				// Skip if worker buffer is full
			}
		}
	}
}
