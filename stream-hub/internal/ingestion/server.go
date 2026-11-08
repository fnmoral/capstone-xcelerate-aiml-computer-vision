package ingestion

import (
	"bufio"
	"encoding/binary"
	"fmt"
	"io"
	"log"
	"net"

	"stream-hub/internal/hub"
)

const (
	// frameHeaderSize is 4 bytes of NALU length + 8 bytes of PTS.
	frameHeaderSize = 12
	maxNALUSize     = 4 * 1024 * 1024
)

// Server handles TCP connections coming from gateways.
type Server struct {
	addr         string
	aiServerAddr string
	broker       *hub.StreamBroker
}

// NewServer creates a new ingestion TCP server instance with a broker reference.
func NewServer(addr string, aiServerAddr string, broker *hub.StreamBroker) *Server {
	return &Server{
		addr:         addr,
		broker:       broker,
		aiServerAddr: aiServerAddr,
	}
}

// Start listens for incoming TCP connections.
func (s *Server) Start() error {
	listener, err := net.Listen("tcp", s.addr)
	if err != nil {
		return err
	}
	defer listener.Close()

	log.Printf("Ingestion TCP server listening on %s", s.addr)

	for {
		conn, err := listener.Accept()
		if err != nil {
			log.Printf("Error accepting connection: %v", err)
			continue
		}

		// Handle each gateway connection in a separate goroutine
		go s.handleConnection(conn)
	}
}

func (s *Server) handleConnection(conn net.Conn) {
	defer conn.Close()
	reader := bufio.NewReader(conn)

	hs, err := ReadHandshake(reader)
	if err != nil {
		log.Printf("handshake failed: %v", err)
		return
	}

	cameraID := hs.Cameras[0]
	log.Printf("Camera [%s] connected (tenant=%s)", cameraID, hs.TenantID)

	// Init AI worker
	log.Printf("Starting AI worker for camera [%s] -> %s", cameraID, s.aiServerAddr)
	aiWorker := hub.NewAIWorker(hs.TenantID, cameraID, s.aiServerAddr)
	// Detections and incident events from the ml-service go to the camera's frontend clients.
	aiWorker.OnResult = func(payload []byte) {
		s.broker.BroadcastMeta(hs.TenantID, cameraID, payload)
	}
	aiWorker.Start()
	s.broker.RegisterAIWorker(hs.TenantID, cameraID, aiWorker)

	// Clean up when the gateway disconnects. Stop also ends the worker's
	// reconnection loop if the Python server is down at that moment.
	defer func() {
		s.broker.UnregisterAIWorker(hs.TenantID, cameraID, aiWorker)
		aiWorker.Stop()
		log.Printf("AIWorker unregistered for camera [%s]", cameraID)
	}()

	for {
		frame, err := readFrame(reader, maxNALUSize)
		if err != nil {
			log.Printf("camera [%s] disconnected: %v", cameraID, err)
			return
		}
		s.broker.BroadcastFrame(hs.TenantID, cameraID, frame)
	}
}

// readFrame reads one frame from the gateway:
// [4 bytes BE uint32: NALU length][8 bytes BE int64: PTS, Unix ms][NALU].
func readFrame(r io.Reader, maxSize uint32) (hub.Frame, error) {
	var hdr [frameHeaderSize]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return hub.Frame{}, err
	}

	n := binary.BigEndian.Uint32(hdr[0:4])
	if n == 0 || n > maxSize {
		return hub.Frame{}, fmt.Errorf("invalid frame size: %d", n)
	}
	pts := int64(binary.BigEndian.Uint64(hdr[4:12]))

	data := make([]byte, n)
	if _, err := io.ReadFull(r, data); err != nil {
		return hub.Frame{}, err
	}
	return hub.Frame{PTS: pts, Data: data}, nil
}

// readLengthPrefixedBytes reads [4 bytes BE length][payload]. Kept for the
// handshake, whose format did not change.
func readLengthPrefixedBytes(r io.Reader, maxSize uint32) ([]byte, error) {
	var lenBuf [4]byte
	if _, err := io.ReadFull(r, lenBuf[:]); err != nil {
		return nil, err
	}
	n := binary.BigEndian.Uint32(lenBuf[:])
	if n == 0 || n > maxSize {
		return nil, fmt.Errorf("invalid frame size: %d", n)
	}
	payload := make([]byte, n)
	if _, err := io.ReadFull(r, payload); err != nil {
		return nil, err
	}
	return payload, nil
}
