package rtsp

import (
	"log"

	"gateway-back/internal/network"
)

// maxDriftMs is how far the derived PTS may drift from the gateway's wall
// clock before the mapper re-anchors (camera clock drift, RTP timestamp
// resets, long stalls).
const maxDriftMs = 5000

// ptsMapper converts RTP timestamps into wall-clock PTS (Unix epoch, ms).
//
// All RTP packets of one picture share the same RTP timestamp, so every NALU
// of that picture gets the same PTS, no matter how many packets it spans or
// when each one arrived. Spacing between frames comes from the camera's own
// clock, which removes network jitter from the timeline.
//
// Not safe for concurrent use: gortsplib calls OnPacketRTP for one media from
// a single goroutine, and each connection creates its own mapper.
type ptsMapper struct {
	cameraID  string
	clockRate int64

	started  bool
	anchorMs int64  // wall clock (ms) at the anchor packet
	lastRTP  uint32 // last RTP timestamp seen
	elapsed  int64  // RTP ticks since the anchor, wraparound-safe
}

func newPTSMapper(cameraID string, clockRate int) *ptsMapper {
	if clockRate <= 0 {
		clockRate = 90000 // standard video clock rate
	}
	return &ptsMapper{cameraID: cameraID, clockRate: int64(clockRate)}
}

// PTS returns the wall-clock PTS (Unix epoch, ms) for an RTP timestamp.
func (m *ptsMapper) PTS(rtpTS uint32) int64 {
	if !m.started {
		m.anchor(rtpTS)
		return m.anchorMs
	}

	// int32 difference handles the 32-bit wraparound (~13 h at 90 kHz) and
	// small reorderings (negative delta) correctly.
	m.elapsed += int64(int32(rtpTS - m.lastRTP))
	m.lastRTP = rtpTS

	pts := m.anchorMs + m.elapsed*1000/m.clockRate

	if drift := network.NowPTS() - pts; drift > maxDriftMs || drift < -maxDriftMs {
		log.Printf("[%s] PTS drifted %d ms from wall clock, re-anchoring", m.cameraID, drift)
		m.anchor(rtpTS)
		return m.anchorMs
	}

	return pts
}

func (m *ptsMapper) anchor(rtpTS uint32) {
	m.started = true
	m.anchorMs = network.NowPTS()
	m.lastRTP = rtpTS
	m.elapsed = 0
}
