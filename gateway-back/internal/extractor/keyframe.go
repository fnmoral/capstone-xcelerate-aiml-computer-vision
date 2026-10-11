// Package extractor provides utilities to inspect RTP packets and extract
// H.264 keyframes (IDR frames) from a video stream.
package extractor

import (
	"fmt"

	"github.com/bluenviron/gortsplib/v5/pkg/format"
	"github.com/bluenviron/gortsplib/v5/pkg/format/rtph264"
	"github.com/pion/rtp"
)

// KeyframeExtractor inspects RTP packets to detect and extract H.264 I-Frames.
//
// It wraps an H.264 RTP decoder and analyzes the NALU type of each decoded
// fragment to determine whether it belongs to a keyframe (IDR picture).
type KeyframeExtractor struct {
	// decoder is the H.264 RTP decoder used to reconstruct NALUs from RTP packets.
	decoder *rtph264.Decoder
}

// NewKeyframeExtractor initializes the RTP decoder for H.264.
//
// It verifies that the provided format is H.264 and creates the corresponding
// RTP decoder.
//
// Returns an error if the format is not supported or if the decoder cannot
// be created.
func NewKeyframeExtractor(forma format.Format) (*KeyframeExtractor, error) {
	h264Format, ok := forma.(*format.H264)
	if !ok {
		return nil, fmt.Errorf("Format not supported by this extractor: %T", forma)
	}

	// Initialize the H.264-specific RTP decoder.
	decoder, err := h264Format.CreateDecoder()
	if err != nil {
		return nil, fmt.Errorf("ERROR creating the H264 RTP decoder: %w", err)
	}

	return &KeyframeExtractor{
		decoder: decoder,
	}, nil
}

// ProcessPacket takes an RTP packet and returns the NALUs it contains.
//
// The returned boolean indicates whether the packet contains a keyframe (IDR).
//
// The NALUs are always returned regardless of whether they belong to a keyframe,
// so that the video stream can be sent fluidly. The boolean is provided as
// additional information for callers that need to react to keyframes
// specifically.
func (e *KeyframeExtractor) ProcessPacket(pkt *rtp.Packet) ([][]byte, bool) {
	nalus, err := e.decoder.Decode(pkt)
	if err != nil || len(nalus) == 0 {
		return nil, false
	}

	isKeyframe := false

	for _, nalu := range nalus {
		if len(nalu) == 0 {
			continue
		}

		// In H.264, the first 5 bits of the header byte indicate the NALU type.
		// NALU Type 5 = Coded slice of an IDR picture (Keyframe/I-Frame).
		naluType := nalu[0] & 0x1F

		if naluType == 5 {
			isKeyframe = true
			break
		}
	}

	// Critical change: ALWAYS return the NALUs to send fluid video,
	// regardless of whether they contain a keyframe or not.
	return nalus, isKeyframe
}
