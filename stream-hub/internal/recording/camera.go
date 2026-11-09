package recording

import (
	"sort"

	"stream-hub/internal/hub"
)

// entry is one NALU of a camera's recent video, as ingested.
type entry struct {
	pts     int64
	data    []byte
	key     bool // part of a keyframe
	picture bool // carries picture data (a slice)
}

// clip is a recording in progress.
type clip struct {
	tenantID   string
	cameraID   string
	incidentID string
	codec      hub.Codec
	nalus      [][]byte
	firstPTS   int64
	lastPTS    int64
	pictures   int
	lastPicPTS int64
	stopAt     int64 // PTS at which to finish; 0 = still recording
	hardEnd    int64 // PTS at which to finish no matter what (max_s)
}

func (c *clip) add(e entry) {
	c.nalus = append(c.nalus, e.data)
	c.lastPTS = e.pts
	if e.picture && (c.pictures == 0 || e.pts != c.lastPicPTS) {
		c.pictures++
		c.lastPicPTS = e.pts
	}
}

// cameraLoop is one camera's dashcam loop and its running clips. Not safe for
// concurrent use: the Manager serialises access per camera.
type cameraLoop struct {
	tenantID  string
	cameraID  string
	cfg       Config
	codec     hub.Codec
	params    map[int][]byte // latest parameter set per NAL type
	buf       []entry        // starts at a keyframe once one has been seen
	bufBytes  int
	keyStarts []int64 // PTS of each keyframe in buf, oldest first
	active    map[string]*clip
}

func newCameraLoop(tenantID, cameraID string, cfg Config) *cameraLoop {
	return &cameraLoop{
		tenantID: tenantID,
		cameraID: cameraID,
		cfg:      cfg,
		params:   make(map[int][]byte),
		active:   make(map[string]*clip),
	}
}

// feed adds one NALU to the loop and to every running clip. It returns the clips
// that reached their end with this NALU.
func (l *cameraLoop) feed(f hub.Frame) []*clip {
	if l.codec == hub.CodecUnknown {
		if l.codec = hub.DetectCodec(f.Data); l.codec == hub.CodecUnknown {
			return nil // nothing is decodable before the first parameter set
		}
	}

	kind, t := hub.Classify(l.codec, f.Data)
	if kind == hub.KindParamSet {
		l.params[t] = f.Data
	}
	e := entry{pts: f.PTS, data: f.Data, key: kind == hub.KindKeyframe, picture: hub.IsPicture(l.codec, f.Data)}

	if e.key && (len(l.keyStarts) == 0 || l.keyStarts[len(l.keyStarts)-1] != e.pts) {
		l.keyStarts = append(l.keyStarts, e.pts)
	}
	l.buf = append(l.buf, e)
	l.bufBytes += len(e.data)
	l.trim(e.pts)

	var finished []*clip
	for id, c := range l.active {
		c.add(e)
		if (c.stopAt != 0 && e.pts >= c.stopAt) || e.pts >= c.hardEnd {
			delete(l.active, id)
			finished = append(finished, c)
		}
	}
	return finished
}

// trim keeps pre_roll_s of video, starting at a keyframe so a clip can be decoded.
func (l *cameraLoop) trim(now int64) {
	cutoff := now - int64(l.cfg.PreRollS*1000)
	limit := int(l.cfg.BufferMB * 1024 * 1024)

	for len(l.keyStarts) >= 2 && (l.keyStarts[1] <= cutoff || l.bufBytes > limit) {
		l.dropBefore(l.keyStarts[1])
		l.keyStarts = l.keyStarts[1:]
	}
	if len(l.keyStarts) == 0 { // no keyframe yet: don't let it grow
		for len(l.buf) > 0 && (l.buf[0].pts < cutoff || l.bufBytes > limit) {
			l.bufBytes -= len(l.buf[0].data)
			l.buf = l.buf[1:]
		}
	}
}

// dropBefore removes the entries before the keyframe with the given PTS.
func (l *cameraLoop) dropBefore(keyPTS int64) {
	i := 0
	for i < len(l.buf) && !(l.buf[i].key && l.buf[i].pts == keyPTS) {
		l.bufBytes -= len(l.buf[i].data)
		i++
	}
	l.buf = l.buf[i:]
}

// start begins a clip with the loop's video (from its oldest keyframe).
func (l *cameraLoop) start(incidentID string) {
	if _, running := l.active[incidentID]; running || l.codec == hub.CodecUnknown || len(l.buf) == 0 {
		return
	}

	from := 0
	for from < len(l.buf) && !l.buf[from].key {
		from++
	}
	if from == len(l.buf) {
		from = 0 // no keyframe yet: ffmpeg skips what it can't decode
	}
	items := l.buf[from:]

	c := &clip{
		tenantID:   l.tenantID,
		cameraID:   l.cameraID,
		incidentID: incidentID,
		codec:      l.codec,
		nalus:      l.orderedParams(),
		firstPTS:   items[0].pts,
	}
	for _, e := range items {
		c.add(e)
	}
	c.hardEnd = c.firstPTS + int64(l.cfg.MaxS*1000)
	l.active[incidentID] = c
}

// stop finishes a clip post_roll_s after the newest video.
func (l *cameraLoop) stop(incidentID string) {
	if c, ok := l.active[incidentID]; ok && c.stopAt == 0 {
		c.stopAt = c.lastPTS + int64(l.cfg.PostRollS*1000)
	}
}

// closeAll ends every running clip (the camera disconnected).
func (l *cameraLoop) closeAll() []*clip {
	finished := make([]*clip, 0, len(l.active))
	for id, c := range l.active {
		delete(l.active, id)
		finished = append(finished, c)
	}
	return finished
}

// orderedParams returns the cached parameter sets in decoding order (VPS, SPS, PPS).
func (l *cameraLoop) orderedParams() [][]byte {
	types := make([]int, 0, len(l.params))
	for t := range l.params {
		types = append(types, t)
	}
	sort.Ints(types)
	out := make([][]byte, 0, len(types))
	for _, t := range types {
		out = append(out, l.params[t])
	}
	return out
}
