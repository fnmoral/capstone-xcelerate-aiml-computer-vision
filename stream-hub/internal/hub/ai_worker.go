package hub

import (
	"encoding/binary"
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
)

// AIWorker forwards the NALUs of one camera, in order, to the Python ml-service.
//
// Every new connection to Python starts a fresh decoder there, so the worker
// waits for a keyframe and sends the cached parameter sets right before it.
// The same happens when the broker had to drop frames for this worker.
type AIWorker struct {
	TenantID     string
	CameraID     string
	AiServerAddr string
	InputChan    chan Frame

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

		if err := sendFrame(conn, Frame{Data: []byte(w.CameraID)}); err != nil {
			conn.Close()
			if !w.wait(2 * time.Second) {
				return
			}
			continue
		}
		log.Printf("Handshake sent to Python for camera [%s]", w.CameraID)

		finished := w.forward(conn, st)
		conn.Close()
		if finished {
			return
		}
		if !w.wait(2 * time.Second) {
			return
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

	// Codec not known yet: forward as-is, as before. The gateway sends the
	// parameter sets first, so this only lasts for the first NALUs.
	if st.codec == CodecUnknown {
		return sendFrame(conn, f)
	}

	if w.resync.Swap(false) {
		st.waitKeyframe = true
	}

	if st.waitKeyframe {
		if kind != KindKeyframe {
			return nil // parameter sets are already cached by observe
		}
		for _, ps := range st.orderedParams() {
			if err := sendFrame(conn, Frame{PTS: f.PTS, Data: ps}); err != nil {
				return err
			}
		}
		st.waitKeyframe = false
	}

	return sendFrame(conn, f)
}

// sendFrame writes a frame in the format the ml-service reads today:
// [4 bytes BE length][NALU]. The PTS is not sent yet; the next stage adds it
// together with the change on the Python side.
func sendFrame(conn net.Conn, f Frame) error {
	var hdr [4]byte
	binary.BigEndian.PutUint32(hdr[:], uint32(len(f.Data)))
	bufs := net.Buffers{hdr[:], f.Data}

	conn.SetWriteDeadline(time.Now().Add(aiWriteTimeout))
	_, err := bufs.WriteTo(conn)
	return err
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
