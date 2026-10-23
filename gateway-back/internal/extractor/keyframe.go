// Package extractor provides utilities to inspect RTP packets and extract
// H.264 / H.265 NALUs and keyframes from a video stream.
package extractor

import (
	"fmt"

	"github.com/bluenviron/gortsplib/v5/pkg/format"
	"github.com/pion/rtp"
)

// KeyframeExtractor inspects RTP packets to rebuild NALUs and detect keyframes.
//
// It wraps the codec's RTP decoder (H.264 or H.265; most IP cameras default to
// H.265) and knows which NALU types start a keyframe in that codec.
type KeyframeExtractor struct {
	// Codec is "H264" or "H265".
	Codec string
	// ParameterSets are the stream's SPS/PPS (H.264) or VPS/SPS/PPS (H.265) from the
	// RTSP description, to send before the first frame so decoding can start at once.
	ParameterSets [][]byte

	decode     func(*rtp.Packet) ([][]byte, error)
	isKeyframe func(nalu []byte) bool
}

// NewKeyframeExtractor initializes the RTP decoder for the track's codec.
//
// Returns an error if the format is neither H.264 nor H.265, or if the decoder
// cannot be created.
func NewKeyframeExtractor(forma format.Format) (*KeyframeExtractor, error) {
	switch f := forma.(type) {
	case *format.H264:
		decoder, err := f.CreateDecoder()
		if err != nil {
			return nil, fmt.Errorf("ERROR creating the H264 RTP decoder: %w", err)
		}
		return &KeyframeExtractor{
			Codec:         "H264",
			ParameterSets: nonEmpty(f.SPS, f.PPS),
			decode:        decoder.Decode,
			// The first 5 bits of the header byte are the NALU type; 5 = IDR picture.
			isKeyframe: func(nalu []byte) bool { return nalu[0]&0x1F == 5 },
		}, nil
	case *format.H265:
		decoder, err := f.CreateDecoder()
		if err != nil {
			return nil, fmt.Errorf("ERROR creating the H265 RTP decoder: %w", err)
		}
		return &KeyframeExtractor{
			Codec:         "H265",
			ParameterSets: nonEmpty(f.VPS, f.SPS, f.PPS),
			decode:        decoder.Decode,
			// Bits 1-6 of the first header byte are the NALU type; 16-23 are IRAP
			// (random access) pictures: IDR, CRA, BLA.
			isKeyframe: func(nalu []byte) bool { t := (nalu[0] >> 1) & 0x3F; return t >= 16 && t <= 23 },
		}, nil
	default:
		return nil, fmt.Errorf("Format not supported by this extractor: %T (the camera must send H.264 or H.265)", forma)
	}
}

func nonEmpty(sets ...[]byte) [][]byte {
	out := make([][]byte, 0, len(sets))
	for _, s := range sets {
		if len(s) > 0 {
			out = append(out, s)
		}
	}
	return out
}

// ProcessPacket takes an RTP packet and returns the NALUs it contains.
//
// The returned boolean indicates whether the packet contains a keyframe.
//
// The NALUs are always returned regardless of whether they belong to a keyframe,
// so that the video stream can be sent fluidly. The boolean is provided as
// additional information for callers that need to react to keyframes
// specifically.
func (e *KeyframeExtractor) ProcessPacket(pkt *rtp.Packet) ([][]byte, bool) {
	nalus, err := e.decode(pkt)
	if err != nil || len(nalus) == 0 {
		return nil, false
	}

	isKeyframe := false
	for _, nalu := range nalus {
		if len(nalu) > 0 && e.isKeyframe(nalu) {
			isKeyframe = true
			break
		}
	}

	// ALWAYS return the NALUs to send fluid video, keyframe or not.
	return nalus, isKeyframe
}
