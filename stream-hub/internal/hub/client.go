package hub

import "sync/atomic"

// Frame is one NALU together with the PTS of the picture it belongs to.
type Frame struct {
	PTS  int64  // Unix epoch in ms, assigned by the gateway; shared by every NALU of one picture
	Data []byte // the NALU (Annex B for frontend clients, as ingested for AI workers)
}

// Client is a frontend subscriber of one camera stream.
type Client struct {
	ID       string
	SendChan chan Frame
	TenantID string
	CameraID string

	// MetaChan receives the ml-service results (JSON) for this camera.
	// Leave it nil for clients that only want video.
	MetaChan chan []byte

	// resync is set by the broker when it had to drop a frame for this client
	// because its buffer was full. After a drop, the decoder needs a new keyframe.
	resync atomic.Bool
}

// NeedsResync reports, and clears, whether frames were dropped for this client
// since the last call. The consumer must then wait for the next keyframe
// (sending the parameter sets first) before forwarding video again.
func (c *Client) NeedsResync() bool {
	return c.resync.Swap(false)
}
