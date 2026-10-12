package hub

import (
	"encoding/binary"
	"log"
	"net"
	"time"
)

// AIWorker (o PythonForwarder) reenvía todos los NALUs secuencialmente al servidor Python.
type AIWorker struct {
	TenantID     string
	CameraID     string
	AiServerAddr string
	InputChan    chan []byte
	stopChan     chan struct{}
}

func NewAIWorker(tenantID, cameraID string, aiServerAddr string) *AIWorker {
	return &AIWorker{
		TenantID:     tenantID,
		CameraID:     cameraID,
		AiServerAddr: aiServerAddr,
		InputChan:    make(chan []byte, 500),
		stopChan:     make(chan struct{}),
	}
}

func (w *AIWorker) Start() {
	go func() {
		for {
			select {
			case <-w.stopChan:
				return
			default:
			}

			log.Printf("Connecting to Python server at %s for camera [%s]...", w.AiServerAddr, w.CameraID)
			conn, err := net.Dial("tcp", w.AiServerAddr)
			if err != nil {
				log.Printf("Python server unreachable (%v). Retrying in 3s...", err)
				time.Sleep(3 * time.Second)
				continue
			}

			idBytes := []byte(w.CameraID)
			var lenBuf [4]byte
			binary.BigEndian.PutUint32(lenBuf[:], uint32(len(idBytes)))

			if _, err := conn.Write(lenBuf[:]); err != nil {
				conn.Close()
				time.Sleep(2 * time.Second)
				continue
			}
			if _, err := conn.Write(idBytes); err != nil {
				conn.Close()
				time.Sleep(2 * time.Second)
				continue
			}

			log.Printf("Handshake sent to Python for camera [%s]", w.CameraID)

			disconnected := false
			for !disconnected {
				select {
				case <-w.stopChan:
					conn.Close()
					return
				case frame, ok := <-w.InputChan:
					if !ok {
						conn.Close()
						return
					}

					if err := sendFrame(conn, frame); err != nil {
						disconnected = true
					}
				}
			}

			conn.Close()
			time.Sleep(2 * time.Second)
		}
	}()
}

func sendFrame(conn net.Conn, frame []byte) error {
	var frameLenBuf [4]byte
	binary.BigEndian.PutUint32(frameLenBuf[:], uint32(len(frame)))
	if _, err := conn.Write(frameLenBuf[:]); err != nil {
		return err
	}
	_, err := conn.Write(frame)
	return err
}

func (w *AIWorker) Stop() {
	close(w.stopChan)
}
