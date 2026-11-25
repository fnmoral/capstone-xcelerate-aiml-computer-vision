package recording

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"stream-hub/internal/hub"
)

// H.264 NALUs (Annex B): SPS, PPS, an IDR slice and a non-IDR slice.
var (
	sps = []byte{0, 0, 0, 1, 0x67, 0x42, 0x00, 0x1e, 0xab}
	pps = []byte{0, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80}
	idr = []byte{0, 0, 0, 1, 0x65, 0x88, 0x84, 0x00}
	p   = []byte{0, 0, 0, 1, 0x41, 0x9a, 0x02, 0x00}
)

// feedSeconds sends `seconds` of 10 fps video (a keyframe every second) starting at pts.
func feedSeconds(l *cameraLoop, pts int64, seconds int) (int64, []*clip) {
	var done []*clip
	for i := 0; i < seconds*10; i++ {
		if i%10 == 0 {
			done = append(done, l.feed(hub.Frame{PTS: pts, Data: sps})...)
			done = append(done, l.feed(hub.Frame{PTS: pts, Data: pps})...)
			done = append(done, l.feed(hub.Frame{PTS: pts, Data: idr})...)
		} else {
			done = append(done, l.feed(hub.Frame{PTS: pts, Data: p})...)
		}
		pts += 100
	}
	return pts, done
}

func TestLongClipIsWrittenToDiskNotKeptInMemory(t *testing.T) {
	dir := t.TempDir()
	cfg := Config{Dir: dir}.WithDefaults()
	l := newCameraLoop("t", "cam", cfg, dir)
	pts, _ := feedSeconds(l, 1_000_000, 20)
	l.start("inc")
	c := l.active["inc"]
	if c == nil || c.err != nil {
		t.Fatalf("clip not started: %+v", c)
	}
	// Five minutes down: longer than the old 2-minute limit.
	pts, done := feedSeconds(l, pts, 300)
	if len(done) != 0 {
		t.Fatalf("clip ended after %d s, want it to cover the whole fall", (pts-c.firstPTS)/1000)
	}
	l.stop("inc")
	_, done = feedSeconds(l, pts, int(cfg.PostRollS)+1)
	if len(done) != 1 {
		t.Fatalf("clip should end post_roll_s after stop, got %d finished", len(done))
	}
	c = done[0]
	if got := (c.lastPTS - c.firstPTS) / 1000; got < 315 {
		t.Fatalf("clip is %d s long, want the whole event (>= 315 s)", got)
	}
	if err := c.close(); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(c.rawPath)
	if err != nil || info.Size() != c.bytes || c.bytes == 0 {
		t.Fatalf("recording file: %v, size %v, want %d bytes", err, info, c.bytes)
	}
}

func TestClipIsCappedAtMaxS(t *testing.T) {
	dir := t.TempDir()
	cfg := Config{Dir: dir, MaxS: 30}.WithDefaults()
	l := newCameraLoop("t", "cam", cfg, dir)
	pts, _ := feedSeconds(l, 0, 5)
	l.start("inc")
	_, done := feedSeconds(l, pts, 40)
	if len(done) != 1 {
		t.Fatalf("want the clip cut at max_s, got %d finished", len(done))
	}
	done[0].discard()
}

func TestWriteClipRemovesTheRecordingFile(t *testing.T) {
	dir := t.TempDir()
	l := newCameraLoop("t", "cam", Config{Dir: dir}.WithDefaults(), dir)
	pts, _ := feedSeconds(l, 0, 3)
	l.start("inc")
	l.stop("inc")
	_, done := feedSeconds(l, pts, 12)
	if len(done) != 1 {
		t.Fatal("clip did not finish")
	}
	c := done[0]
	ffmpeg := "ffmpeg"
	if _, err := exec.LookPath(ffmpeg); err != nil {
		ffmpeg = filepath.Join(dir, "no-ffmpeg") // the remux fails, but the .rec must still go
	}
	path, _, err := writeClip(ffmpeg, dir, c)
	if _, statErr := os.Stat(c.rawPath); !os.IsNotExist(statErr) {
		t.Fatalf(".rec file left behind: %v", statErr)
	}
	if err == nil {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("clip not written: %v", err)
		}
	}
}

func TestPruneRemovesStaleRecordings(t *testing.T) {
	m, err := NewManager(Config{Dir: t.TempDir(), FFmpegPath: "definitely-not-ffmpeg"})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	stale := filepath.Join(m.clipsDir, "old_cam.mp4.rec")
	fresh := filepath.Join(m.clipsDir, "new_cam.mp4.rec")
	for _, f := range []string{stale, fresh} {
		if err := os.WriteFile(f, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	old := time.Now().Add(-time.Hour)
	os.Chtimes(stale, old, old)
	m.prune()
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatal("a recording cut off by a restart should be deleted")
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Fatal("a recording in progress must be kept")
	}
	if u := m.Usage(); u.ClipBytes != 1 || u.Clips != 0 {
		t.Fatalf("usage %+v", u)
	}
}
