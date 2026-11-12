package recording

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"sync"
	"time"

	"stream-hub/internal/hub"
)

var (
	snapshotName = regexp.MustCompile(`^[\w.-]+\.jpg$`)
	clipName     = regexp.MustCompile(`^[\w.-]+\.mp4$`)
)

const pruneEvery = time.Hour

// Manager owns every camera's loop, the clip writer and the files on disk.
// Feed, Start, Stop and CloseCamera are safe for concurrent use.
type Manager struct {
	cfg         Config
	clipsDir    string
	snapshotDir string
	enabled     bool // false when ffmpeg is missing: clips are off, snapshots still work

	mu      sync.Mutex
	cameras map[string]*lockedLoop

	jobs chan *clip
	done chan struct{}
	stop chan struct{}
}

type lockedLoop struct {
	mu   sync.Mutex
	loop *cameraLoop
}

// NewManager creates the folders and starts the clip writer and the pruner.
func NewManager(cfg Config) (*Manager, error) {
	cfg = cfg.WithDefaults()
	m := &Manager{
		cfg:         cfg,
		clipsDir:    filepath.Join(cfg.Dir, "clips"),
		snapshotDir: filepath.Join(cfg.Dir, "snapshots"),
		cameras:     make(map[string]*lockedLoop),
		jobs:        make(chan *clip, 32),
		done:        make(chan struct{}),
		stop:        make(chan struct{}),
	}
	for _, d := range []string{m.clipsDir, m.snapshotDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return nil, fmt.Errorf("recordings dir: %w", err)
		}
	}

	if _, err := exec.LookPath(cfg.FFmpegPath); err != nil {
		log.Printf("WARNING: %q not found (%v): incident clips are OFF, snapshots still work", cfg.FFmpegPath, err)
	} else {
		m.enabled = true
	}

	go m.writeLoop()
	log.Printf("Recordings in %s: clips %.0f s before to %.0f s after a fall (max %.0f s)",
		cfg.Dir, cfg.PreRollS, cfg.PostRollS, cfg.MaxS)
	return m, nil
}

func (m *Manager) camera(tenantID, cameraID string) *lockedLoop {
	key := tenantID + "/" + cameraID
	m.mu.Lock()
	defer m.mu.Unlock()
	c, ok := m.cameras[key]
	if !ok {
		c = &lockedLoop{loop: newCameraLoop(tenantID, cameraID, m.cfg)}
		m.cameras[key] = c
	}
	return c
}

// Feed adds one ingested NALU to the camera's loop.
func (m *Manager) Feed(tenantID, cameraID string, f hub.Frame) {
	if !m.enabled {
		return
	}
	c := m.camera(tenantID, cameraID)
	c.mu.Lock()
	finished := c.loop.feed(f)
	c.mu.Unlock()
	m.submit(finished)
}

// Start begins a clip for an incident on a camera (the ml-service confirmed a fall).
func (m *Manager) Start(tenantID, cameraID, incidentID string) {
	if !m.enabled {
		return
	}
	c := m.camera(tenantID, cameraID)
	c.mu.Lock()
	c.loop.start(incidentID)
	c.mu.Unlock()
	log.Printf("[%s] recording clip for incident %s", cameraID, incidentID)
}

// Stop finishes a clip post_roll_s from now (the person is up or out of view).
func (m *Manager) Stop(tenantID, cameraID, incidentID string) {
	if !m.enabled {
		return
	}
	c := m.camera(tenantID, cameraID)
	c.mu.Lock()
	c.loop.stop(incidentID)
	c.mu.Unlock()
}

// CloseCamera saves the camera's running clips and forgets its loop (the gateway disconnected).
func (m *Manager) CloseCamera(tenantID, cameraID string) {
	key := tenantID + "/" + cameraID
	m.mu.Lock()
	c, ok := m.cameras[key]
	delete(m.cameras, key)
	m.mu.Unlock()
	if !ok {
		return
	}
	c.mu.Lock()
	finished := c.loop.closeAll()
	c.mu.Unlock()
	m.submit(finished)
}

func (m *Manager) submit(clips []*clip) {
	for _, c := range clips {
		select {
		case m.jobs <- c:
		default:
			log.Printf("[%s] clip writer is busy: clip for incident %s dropped", c.cameraID, c.incidentID)
		}
	}
}

// SaveSnapshot stores an incident image sent by the ml-service.
func (m *Manager) SaveSnapshot(name string, jpeg []byte) error {
	if !snapshotName.MatchString(name) {
		return fmt.Errorf("invalid snapshot name %q", name)
	}
	path := filepath.Join(m.snapshotDir, name)
	tmp := path + ".part"
	if err := os.WriteFile(tmp, jpeg, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// SnapshotPath returns the file of a stored snapshot, if it exists.
func (m *Manager) SnapshotPath(name string) (string, bool) {
	return existing(m.snapshotDir, name, snapshotName)
}

// ClipPath returns the file of a stored clip, if it exists.
func (m *Manager) ClipPath(name string) (string, bool) {
	return existing(m.clipsDir, name, clipName)
}

func existing(dir, name string, valid *regexp.Regexp) (string, bool) {
	if !valid.MatchString(name) {
		return "", false
	}
	path := filepath.Join(dir, name)
	info, err := os.Stat(path)
	return path, err == nil && info.Mode().IsRegular()
}

// Close finishes the clips already queued and stops the background work.
func (m *Manager) Close() {
	close(m.stop)
	<-m.done
}

func (m *Manager) writeLoop() {
	defer close(m.done)
	m.prune()
	ticker := time.NewTicker(pruneEvery)
	defer ticker.Stop()
	for {
		select {
		case c := <-m.jobs:
			m.write(c)
		case <-ticker.C:
			m.prune()
		case <-m.stop:
			for {
				select {
				case c := <-m.jobs:
					m.write(c)
				default:
					return
				}
			}
		}
	}
}

func (m *Manager) write(c *clip) {
	path, seconds, err := writeClip(m.cfg.FFmpegPath, m.clipsDir, c)
	if err != nil {
		log.Printf("[%s] clip for incident %s not saved: %v", c.cameraID, c.incidentID, err)
		return
	}
	size := int64(0)
	if info, err := os.Stat(path); err == nil {
		size = info.Size()
	}
	log.Printf("[%s] clip saved: %s (%d frames, %.0f s, %.1f MB)", c.cameraID, filepath.Base(path),
		c.pictures, seconds, float64(size)/1e6)
}

// prune deletes clips past retention_days, then the oldest while over max_total_gb,
// and leftovers of interrupted writes.
func (m *Manager) prune() {
	type file struct {
		path string
		size int64
		mod  time.Time
	}
	var files []file
	entries, err := os.ReadDir(m.clipsDir)
	if err != nil {
		return
	}
	now := time.Now()
	for _, e := range entries {
		info, err := e.Info()
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		path := filepath.Join(m.clipsDir, e.Name())
		switch filepath.Ext(e.Name()) {
		case ".mp4":
			files = append(files, file{path, info.Size(), info.ModTime()})
		case ".part":
			if now.Sub(info.ModTime()) > 10*time.Minute {
				os.Remove(path)
			}
		}
	}
	sort.Slice(files, func(i, j int) bool { return files[i].mod.Before(files[j].mod) })

	removed := 0
	if m.cfg.RetentionDays > 0 {
		cutoff := now.Add(-time.Duration(m.cfg.RetentionDays * 24 * float64(time.Hour)))
		for len(files) > 0 && files[0].mod.Before(cutoff) {
			os.Remove(files[0].path)
			files = files[1:]
			removed++
		}
	}
	if m.cfg.MaxTotalGB > 0 {
		var total int64
		for _, f := range files {
			total += f.size
		}
		for len(files) > 0 && float64(total) > m.cfg.MaxTotalGB*1e9 {
			total -= files[0].size
			os.Remove(files[0].path)
			files = files[1:]
			removed++
		}
	}
	if removed > 0 {
		log.Printf("Recordings: deleted %d old clip(s)", removed)
	}
}
