package ingestion

import (
	"encoding/binary"
	"fmt"
	"io"
)

// HandshakeMessage represents the initial payload sent by the gateway upon connection.
type HandshakeMessage struct {
	TenantID string   `json:"tenant_id"`
	Cameras  []string `json:"cameras"`
}

// ReadHandshake reads and decodes the handshake JSON from the connection reader.
func ReadHandshake(r io.Reader) (*HandshakeMessage, error) {
	tenantID, err := readLengthPrefixedString(r, 256)
	if err != nil {
		return nil, fmt.Errorf("reading tenant_id: %w", err)
	}

	cameraID, err := readLengthPrefixedString(r, 256)
	if err != nil {
		return nil, fmt.Errorf("reading camera_id: %w", err)
	}

	return &HandshakeMessage{
		TenantID: tenantID,
		Cameras:  []string{cameraID},
	}, nil
}

func readLengthPrefixedString(r io.Reader, maxLen uint32) (string, error) {
	var lenBuf [4]byte
	if _, err := io.ReadFull(r, lenBuf[:]); err != nil {
		return "", err
	}
	n := binary.BigEndian.Uint32(lenBuf[:])
	if n == 0 || n > maxLen {
		return "", fmt.Errorf("Invalid string length: %d", n)
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return "", err
	}
	return string(buf), nil
}
