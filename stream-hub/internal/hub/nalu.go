package hub

// Codec identifies the video codec of a stream, detected from its parameter sets.
type Codec int

const (
	CodecUnknown Codec = iota
	CodecH264
	CodecH265
)

// NALUKind is the role a NALU plays for a decoder that joins the stream.
type NALUKind int

const (
	KindOther    NALUKind = iota
	KindParamSet          // H.264 SPS/PPS, H.265 VPS/SPS/PPS
	KindKeyframe          // H.264 IDR, H.265 IRAP (IDR/CRA/BLA)
)

// naluPayload returns the NALU without its Annex B start code (3 or 4 bytes), if any.
func naluPayload(b []byte) []byte {
	switch {
	case len(b) >= 4 && b[0] == 0 && b[1] == 0 && b[2] == 0 && b[3] == 1:
		return b[4:]
	case len(b) >= 3 && b[0] == 0 && b[1] == 0 && b[2] == 1:
		return b[3:]
	}
	return b
}

// DetectCodec recognizes the codec from a parameter set NALU: an H.265 VPS or an
// H.264 SPS. It returns CodecUnknown for any other NALU.
//
// The H.265 check comes first and is strict (0x40 0x01, VPS of layer 0): in
// H.264 a header byte of 0x40 would be NAL type 0, which encoders never emit.
func DetectCodec(nalu []byte) Codec {
	h := naluPayload(nalu)
	if len(h) >= 2 && h[0] == 0x40 && h[1] == 0x01 {
		return CodecH265
	}
	if len(h) >= 1 && h[0]&0x80 == 0 && h[0]&0x1f == 7 {
		return CodecH264
	}
	return CodecUnknown
}

// Classify returns the kind of a NALU and its NAL type number for the given codec.
func Classify(c Codec, nalu []byte) (NALUKind, int) {
	h := naluPayload(nalu)
	if len(h) == 0 {
		return KindOther, -1
	}

	switch c {
	case CodecH264:
		t := int(h[0] & 0x1f)
		switch {
		case t == 7 || t == 8:
			return KindParamSet, t
		case t == 5:
			return KindKeyframe, t
		}
		return KindOther, t

	case CodecH265:
		t := int(h[0]>>1) & 0x3f
		switch {
		case t >= 32 && t <= 34:
			return KindParamSet, t
		case t >= 16 && t <= 21:
			return KindKeyframe, t
		}
		return KindOther, t
	}

	return KindOther, -1
}

// IsPicture reports whether a NALU carries picture data (a slice), as opposed to
// parameter sets, SEI or delimiters.
func IsPicture(c Codec, nalu []byte) bool {
	h := naluPayload(nalu)
	if len(h) == 0 {
		return false
	}
	switch c {
	case CodecH264:
		t := h[0] & 0x1f
		return t >= 1 && t <= 5
	case CodecH265:
		return (h[0]>>1)&0x3f <= 31
	}
	return false
}
