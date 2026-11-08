package hub

import (
	"bufio"
	"encoding/binary"
	"fmt"
	"io"
	"log"
	"net"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

const (
	aiDialTimeout  = 3 * time.Second
	aiWriteTimeout = 5 * time.Second

	// maxResultSize bounds one JSON result from the ml-service.
	maxResultSize = 1 << 20
)

// AIWorker exchanges one camera's stream with the Python ml-service over one TCP
// connection:
//
//	Handshake (hub -> ML):  [4 len][tenantID] [4 len][cameraID]
//	Video     (hub -> ML):  [4 len][8 PTS int64, Unix ms][NALU]   (repeated)
//	Results   (ML -> hub):  [4 len][JSON]                          (repeated)
//
// Every new connection starts a fresh decoder in Python, so the worker waits for
// a keyframe and sends the cached parameter sets right before it. The same
// happens when the broker had to drop frames for this worker.
type AIWorker struct {
	TenantID     string
	CameraID     string
	AiServerAddr string
	InputChan    chan Frame

	// OnResult is called with each JSON result the ml-service sends back.
	// Set it before Start. It runs on the worker's reader goroutine.
	OnResult func(payload []byte)

	stopChan chan struct{}
	stopOnce sync.Once

	// resync is set by the broker when it dropped a frame for this worker.
	resync atomic.Bool
}

func NewAIWorker(tenantID, cameraID string, aiServerAddr string) *AIWorker {
	return &AIWorker{
		TenantID:     tenantID,
		CameraID:     cameraID,
		AiServerAddr: aiServerAddr,
		InputChan:    make(chan Frame, 500),
		stopChan:     make(chan struct{}),
	}
}

// aiStreamState is what the worker knows about the stream across reconnections.
type aiStreamState struct {
	codec        Codec
	params       map[int][]byte // latest parameter set per NAL type
	waitKeyframe bool
}

// observe detects the codec and caches parameter sets; it returns the NALU kind.
func (st *aiStreamState) observe(f Frame) NALUKind {
	if st.codec == CodecUnknown {
		st.codec = DetectCodec(f.Data)
	}
	kind, t := Classify(st.codec, f.Data)
	if kind == KindParamSet {
		st.params[t] = f.Data
	}
	return kind
}

// orderedParams returns the cached parameter sets in decoding order
// (VPS, SPS, PPS), which matches ascending NAL type in both codecs.
func (st *aiStreamState) orderedParams() [][]byte {
	types := make([]int, 0, len(st.params))
	for t := range st.params {
		types = append(types, t)
	}
	sort.Ints(types)
	out := make([][]byte, 0, len(types))
	for _, t := range types {
		out = append(out, st.params[t])
	}
	return out
}

func (w *AIWorker) Start() {
	go w.run()
}

func (w *AIWorker) run() {
	st := &aiStreamState{params: make(map[int][]byte)}

	for {
		select {
		case <-w.stopChan:
			return
		default:
		}

		log.Printf("Connecting to Python server at %s for camera [%s]...", w.AiServerAddr, w.CameraID)
		conn, err := net.DialTimeout("tcp", w.AiServerAddr, aiDialTimeout)
		if err != nil {
			log.Printf("Python server unreachable (%v). Retrying in 3s...", err)
			if !w.wait(3 * time.Second) {
				return
			}
			continue
		}

		if err := w.sendHandshake(conn); err != nil {
			conn.Close()
			if !w.wait(2 * time.Second) {
				return
			}
			continue
		}
		log.Printf("Handshake sent to Python for camera [%s]", w.CameraID)

		go w.readResults(conn)

		finished := w.forward(conn, st)
		conn.Close() // also ends readResults
		if finished {
			return
		}
		if !w.wait(2 * time.Second) {
			return
		}
	}
}

func (w *AIWorker) sendHandshake(conn net.Conn) error {
	conn.SetWriteDeadline(time.Now().Add(aiWriteTimeout))
	defer conn.SetWriteDeadline(time.Time{})
	if err := writeMessage(conn, []byte(w.TenantID)); err != nil {
		return err
	}
	return writeMessage(conn, []byte(w.CameraID))
}

// readResults delivers the ml-service results until the connection closes.
// On a read error it closes the connection, so the writer notices and reconnects.
func (w *AIWorker) readResults(conn net.Conn) {
	r := bufio.NewReader(conn)
	for {
		payload, err := readMessage(r, maxResultSize)
		if err != nil {
			conn.Close()
			return
		}
		if w.OnResult != nil {
			w.OnResult(payload)
		}
	}
}

// forward sends frames until the connection fails (returns false) or the
// worker is stopped or its input is closed (returns true).
func (w *AIWorker) forward(conn net.Conn, st *aiStreamState) bool {
	// Whatever queued up while disconnected is stale: drop it, keeping its
	// parameter sets, and start the new Python decoder at the next keyframe.
	if closed := w.drainStale(st); closed {
		return true
	}
	w.resync.Store(false)
	st.waitKeyframe = true

	for {
		select {
		case <-w.stopChan:
			return true
		case f, ok := <-w.InputChan:
			if !ok {
				return true
			}
			if err := w.handleFrame(conn, st, f); err != nil {
				log.Printf("Python connection lost for camera [%s]: %v", w.CameraID, err)
				return false
			}
		}
	}
}

// drainStale empties InputChan without blocking. It reports whether the
// channel was closed.
func (w *AIWorker) drainStale(st *aiStreamState) bool {
	for {
		select {
		case f, ok := <-w.InputChan:
			if !ok {
				return true
			}
			st.observe(f)
		default:
			return false
		}
	}
}

func (w *AIWorker) handleFrame(conn net.Conn, st *aiStreamState, f Frame) error {
	kind := st.observe(f)

	// Codec not known yet: forward as-is. The gateway sends the parameter sets
	// first, so this only lasts for the first NALUs.
	if st.codec == CodecUnknown {
		return writeFrame(conn, f)
	}

	if w.resync.Swap(false) {
		st.waitKeyframe = true
	}

	if st.waitKeyframe {
		if kind != KindKeyframe {
			return nil // parameter sets are already cached by observe
		}
		// Same PTS as the keyframe: Python groups NALUs by PTS into one picture.
		for _, ps := range st.orderedParams() {
			if err := writeFrame(conn, Frame{PTS: f.PTS, Data: ps}); err != nil {
				return err
			}
		}
		st.waitKeyframe = false
	}

	return writeFrame(conn, f)
}

// writeFrame sends [4 bytes BE length][8 bytes BE PTS][NALU] in one write.
func writeFrame(conn net.Conn, f Frame) error {
	var hdr [12]byte
	binary.BigEndian.PutUint32(hdr[0:4], uint32(len(f.Data)))
	binary.BigEndian.PutUint64(hdr[4:12], uint64(f.PTS))
	bufs := net.Buffers{hdr[:], f.Data}

	conn.SetWriteDeadline(time.Now().Add(aiWriteTimeout))
	_, err := bufs.WriteTo(conn)
	return err
}

// writeMessage sends [4 bytes BE length][payload].
func writeMessage(conn net.Conn, payload []byte) error {
	var hdr [4]byte
	binary.BigEndian.PutUint32(hdr[:], uint32(len(payload)))
	bufs := net.Buffers{hdr[:], payload}
	_, err := bufs.WriteTo(conn)
	return err
}

// readMessage reads [4 bytes BE length][payload].
func readMessage(r io.Reader, maxSize uint32) ([]byte, error) {
	var hdr [4]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return nil, err
	}
	n := binary.BigEndian.Uint32(hdr[:])
	if n == 0 || n > maxSize {
		return nil, fmt.Errorf("invalid result size: %d", n)
	}
	payload := make([]byte, n)
	if _, err := io.ReadFull(r, payload); err != nil {
		return nil, err
	}
	return payload, nil
}

// wait sleeps for d; it returns false if the worker was stopped meanwhile.
func (w *AIWorker) wait(d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-w.stopChan:
		return false
	case <-t.C:
		return true
	}
}

// Stop ends the worker, including its reconnection loop. Safe to call more than once.
func (w *AIWorker) Stop() {
	w.stopOnce.Do(func() { close(w.stopChan) })
}
