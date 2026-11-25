package recording

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"

	"stream-hub/internal/hub"
)

var startCode = []byte{0, 0, 0, 1}

// clipMeta is saved next to each clip as <clip>.mp4.json.
type clipMeta struct {
	StartMS int64   `json:"start_ms"` // the first frame's time, Unix ms
	Seconds float64 `json:"seconds"`
}

// clipFileName is the name the ml-service records in the database:
// clips/<incident id>_<camera id>.mp4.
func clipFileName(incidentID, cameraID string) string {
	return incidentID + "_" + cameraID + ".mp4"
}

// writeClip remuxes a finished clip (its .rec file) into an MP4 under dir, without
// re-encoding, and deletes the .rec file. It returns the file path and the clip's length in seconds.
func writeClip(ffmpeg, dir string, c *clip) (string, float64, error) {
	defer c.discard()
	if err := c.close(); err != nil {
		return "", 0, fmt.Errorf("recording: %v", err)
	}
	if c.pictures < 2 {
		return "", 0, fmt.Errorf("no video recorded")
	}
	seconds := float64(c.lastPTS-c.firstPTS) / 1000
	fps := 25.0
	if seconds > 0 {
		fps = float64(c.pictures-1) / seconds
	}

	format, tag := "h264", "avc1"
	if c.codec == hub.CodecH265 {
		format, tag = "hevc", "hvc1" // hvc1: the tag Safari needs to play H.265 in MP4
	}

	path := filepath.Join(dir, clipFileName(c.incidentID, c.cameraID))
	tmp := path + ".part"

	// -r as an input option forces our frame rate: without it ffmpeg trusts the timing written
	// in the stream itself, which some cameras get wrong (a phone app declared 58 fps with odd
	// timing: a 48 s clip came out 1.7 s long, every frame squeezed together).
	rate := fmt.Sprintf("%.3f", fps)
	cmd := exec.Command(ffmpeg,
		"-hide_banner", "-loglevel", "error", "-y",
		"-fflags", "+genpts",
		"-f", format, "-framerate", rate, "-r", rate,
		"-i", c.rawPath,
		"-c", "copy", "-tag:v", tag,
		"-movflags", "+faststart",
		"-f", "mp4", tmp,
	)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		os.Remove(tmp)
		return "", 0, fmt.Errorf("ffmpeg: %v: %s", err, bytes.TrimSpace(stderr.Bytes()))
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return "", 0, err
	}
	// When the clip starts, in wall-clock time (frame PTS are the gateway's Unix ms), so the
	// incident page can jump from the detector timeline to the same moment in the video.
	meta, _ := json.Marshal(clipMeta{StartMS: c.firstPTS, Seconds: seconds})
	if err := os.WriteFile(path+".json", meta, 0o644); err != nil {
		log.Printf("[%s] clip info for incident %s not saved: %v", c.cameraID, c.incidentID, err)
	}
	return path, seconds, nil
}
