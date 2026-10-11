// Package network provides utilities for sending camera frames over TCP to a
// remote server, including a FrameSender that handles the handshake protocol
// and NALU transmission.
package network

import (
	"encoding/binary"
	"fmt"
	"log"
	"net"
	"sync"
)

// FrameSender manages a TCP connection to a remote server for sending camera
// frames (NALUs). It is safe for concurrent use.
//
// Each FrameSender is associated with a single camera ID, which is sent to the
// server during the initial handshake so the server can identify the source
// of the incoming stream.
type FrameSender struct {
	// conn is the underlying TCP connection to the remote server.
	conn net.Conn

	// mu protects concurrent access to the conn field.
	mu sync.Mutex

	// cameraID is the identifier of the camera associated with this sender.
	cameraID string
}

// NewFrameSender creates a new FrameSender by connecting to the given TCP
// address and performing the initial handshake with the server.
//
// The handshake sends the camera ID so the server knows which camera this
// socket belongs to.
//
// Returns an error if the connection or the handshake fails.
func NewFrameSender(address string, cameraID string) (*FrameSender, error) {
	conn, err := net.Dial("tcp", address)
	if err != nil {
		return nil, fmt.Errorf("ERROR connecting to server (%s): %w", address, err)
	}

	sender := &FrameSender{
		conn:     conn,
		cameraID: cameraID,
	}

	// Perform the handshake by sending the camera identity.
	if err := sender.sendHandshake(); err != nil {
		conn.Close()
		return nil, fmt.Errorf("ERROR in handshake with server: %w", err)
	}

	log.Printf("TCP connection & handshake established with %s for camera [%s]", address, cameraID)
	return sender, nil
}

// sendHandshake sends the length of the camera ID first, followed by the ID
// in plain text.
//
// This notifies the server (whether written in Go or Python) which camera
// this socket belongs to.
func (fs *FrameSender) sendHandshake() error {
	idBytes := []byte(fs.cameraID)
	length := uint32(len(idBytes))

	header := make([]byte, 4)
	binary.BigEndian.PutUint32(header, length)

	if _, err := fs.conn.Write(header); err != nil {
		return err
	}
	if _, err := fs.conn.Write(idBytes); err != nil {
		return err
	}
	return nil
}

// SendNALU sends a single H.264 fragment, preceded by its 4-byte length header.
//
// The length is encoded in big-endian format. This method is safe for
// concurrent use.
//
// Returns an error if the connection is not available or if the write fails.
func (fs *FrameSender) SendNALU(nalu []byte) error {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	if fs.conn == nil {
		return fmt.Errorf("Connection not available")
	}

	length := uint32(len(nalu))
	header := make([]byte, 4)
	binary.BigEndian.PutUint32(header, length)

	if _, err := fs.conn.Write(header); err != nil {
		return err
	}
	_, err := fs.conn.Write(nalu)
	return err
}

// Close closes the underlying TCP connection and sets it to nil.
//
// It is safe to call Close multiple times; subsequent calls after the first
// will be no-ops and return nil.
//
// Returns an error if closing the connection fails.
func (fs *FrameSender) Close() error {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	if fs.conn != nil {
		err := fs.conn.Close()
		fs.conn = nil
		return err
	}
	return nil
}
