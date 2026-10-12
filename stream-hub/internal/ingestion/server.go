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

	// Init ai worker
	log.Println(s.aiServerAddr)
	aiWorker := hub.NewAIWorker(hs.TenantID, cameraID, s.aiServerAddr)
	aiWorker.Start()

	// Worker has registered
	s.broker.RegisterAIWorker(hs.TenantID, cameraID, aiWorker)

	// clean and unregister when the gateway is desconected
	defer func() {
		s.broker.UnregisterAIWorker(hs.TenantID, cameraID, aiWorker)
		log.Printf("AIWorker unregistered for camera [%s]", cameraID)
	}()

	for {
		nalu, err := readLengthPrefixedBytes(reader, 4*1024*1024)
		if err != nil {
			log.Printf("camera [%s] disconnected: %v", cameraID, err)
			return
		}

		log.Printf("Retrieve frame NALU from camera [%s], size: %d bytes", cameraID, len(nalu))
		s.broker.BroadcastFrame(hs.TenantID, cameraID, nalu)
	}

}

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
