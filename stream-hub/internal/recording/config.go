// Package recording keeps a short loop of every camera's compressed video and turns
// it into an MP4 clip when the ml-service reports a fall, like a dashcam. It also
// stores the incident snapshots the ml-service sends, and serves both from disk.
//
// Clips are remuxed, not re-encoded: the camera's H.264 / H.265 is copied into an
// MP4 container by ffmpeg ("-c copy"), which costs almost no CPU.
package recording

// Config is the "recordings" section of config.json.
type Config struct {
	Dir           string  `json:"dir"`            // root folder: <dir>/clips and <dir>/snapshots
	PreRollS      float64 `json:"pre_roll_s"`     // video kept from before the fall
	PostRollS     float64 `json:"post_roll_s"`    // and after the person is back up / out of view
	MaxS          float64 `json:"max_s"`          // longest clip
	BufferMB      float64 `json:"buffer_mb"`      // cap on each camera's in-memory loop
	RetentionDays float64 `json:"retention_days"` // delete clips older than this; 0 = keep
	MaxTotalGB    float64 `json:"max_total_gb"`   // then oldest first while bigger; 0 = no cap
	FFmpegPath    string  `json:"ffmpeg_path"`    // ffmpeg binary; empty = "ffmpeg" from PATH
}

// WithDefaults fills the fields left empty.
func (c Config) WithDefaults() Config {
	if c.Dir == "" {
		c.Dir = "data/recordings"
	}
	if c.PreRollS <= 0 {
		c.PreRollS = 15
	}
	if c.PostRollS <= 0 {
		c.PostRollS = 10
	}
	if c.MaxS <= 0 {
		c.MaxS = 120
	}
	if c.BufferMB <= 0 {
		c.BufferMB = 64
	}
	if c.FFmpegPath == "" {
		c.FFmpegPath = "ffmpeg"
	}
	return c
}
