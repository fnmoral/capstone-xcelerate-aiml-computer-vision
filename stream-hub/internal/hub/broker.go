package hub

import (
	"bytes"
	"sync"
)

// StreamBroker manages streams grouped by tenant and camera for both clients and AI workers.
type StreamBroker struct {
	mu          sync.RWMutex
	subscribers map[string]map[string][]*Client   // tenantID -> cameraID -> list of frontend clients
	aiWorkers   map[string]map[string][]*AIWorker // tenantID -> cameraID -> list of AI workers
	pmu         sync.RWMutex
	params      map[string]*paramSets // "tenant/camera" -> SPS/PPS
}

// paramSets keeps the last SPS and PPS (already in Annex B) of a camera.
type paramSets struct{ sps, pps []byte }

// NewStreamBroker creates a new instance of StreamBroker.
func NewStreamBroker() *StreamBroker {
	return &StreamBroker{
		subscribers: make(map[string]map[string][]*Client),
		aiWorkers:   make(map[string]map[string][]*AIWorker),
		params:      make(map[string]*paramSets),
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
		// Compare pointers: two clients behind the same proxy can share an ID.
		if c == client {
			b.subscribers[tenantID][cameraID] = append(clients[:i], clients[i+1:]...)
			close(client.SendChan)
			if client.MetaChan != nil {
				close(client.MetaChan)
			}
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

// BroadcastFrame distributes a frame to all frontend subscribers and AI workers
// listening to a specific tenant and camera. The PTS travels with the frame.
//
// Sends never block ingestion: when a consumer's buffer is full the frame is
// dropped and the consumer is flagged to resync at the next keyframe, because
// a decoder that misses a frame shows garbage until then.
func (b *StreamBroker) BroadcastFrame(tenantID, cameraID string, frame Frame) {
	// Frontend clients get Annex B (what the browser-side muxer expects)
	annexB := Frame{PTS: frame.PTS, Data: ToAnnexB(frame.Data)}
	b.cacheParams(tenantID, cameraID, annexB.Data)

	b.mu.RLock()
	defer b.mu.RUnlock()

	// 1. Broadcast to Frontend WebSocket clients
	if clients, exists := b.subscribers[tenantID][cameraID]; exists {
		for _, client := range clients {
			select {
			case client.SendChan <- annexB:
			default:
				client.resync.Store(true)
			}
		}
	}

	// 2. AI workers keep receiving the frame exactly as ingested
	if workers, exists := b.aiWorkers[tenantID][cameraID]; exists {
		for _, worker := range workers {
			select {
			case worker.InputChan <- frame:
			default:
				worker.resync.Store(true)
			}
		}
	}
}

// BroadcastMeta relays an ml-service result (a JSON object) to the frontend clients
// of a camera that asked for results. The hub does not parse it.
//
// Dropping a result for a slow client is harmless: the next one replaces it.
func (b *StreamBroker) BroadcastMeta(tenantID, cameraID string, payload []byte) {
	b.mu.RLock()
	defer b.mu.RUnlock()

	for _, client := range b.subscribers[tenantID][cameraID] {
		if client.MetaChan == nil {
			continue
		}
		select {
		case client.MetaChan <- payload:
		default:
		}
	}
}

var startCode = []byte{0, 0, 0, 1}

// hasStartCode reports whether b already begins with an Annex B start code.
func hasStartCode(b []byte) bool {
	return bytes.HasPrefix(b, startCode) || bytes.HasPrefix(b, []byte{0, 0, 1})
}

// ToAnnexB returns a copy of the NALU prefixed with a start code (if it lacks one).
// The copy also avoids sharing the ingestion buffer between clients.
func ToAnnexB(nalu []byte) []byte {
	if hasStartCode(nalu) {
		return append([]byte(nil), nalu...)
	}
	out := make([]byte, 0, len(nalu)+4)
	out = append(out, startCode...)
	return append(out, nalu...)
}

// NALType returns the H.264 NAL unit type of a NALU, with or without a
// 3- or 4-byte Annex B start code.
func NALType(nalu []byte) int {
	h := naluPayload(nalu)
	if len(h) == 0 {
		return -1
	}
	return int(h[0] & 0x1f)
}

// ParamSets returns the cached SPS and PPS for a camera (nil if not seen yet).
func (b *StreamBroker) ParamSets(tenantID, cameraID string) (sps, pps []byte) {
	b.pmu.RLock()
	defer b.pmu.RUnlock()
	if p, ok := b.params[tenantID+"/"+cameraID]; ok {
		return p.sps, p.pps
	}
	return nil, nil
}

func (b *StreamBroker) cacheParams(tenantID, cameraID string, annexB []byte) {
	t := NALType(annexB)
	if t != 7 && t != 8 {
		return
	}
	key := tenantID + "/" + cameraID
	b.pmu.Lock()
	defer b.pmu.Unlock()
	p := b.params[key]
	if p == nil {
		p = &paramSets{}
		b.params[key] = p
	}
	if t == 7 {
		p.sps = annexB
	} else {
		p.pps = annexB
	}
}
