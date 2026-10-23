// Package network provides utilities for sending camera frames over TCP to a
// remote server, including a FrameSender that handles the handshake protocol
// and NALU transmission with automatic reconnection.
package network

import (
	"encoding/binary"
	"fmt"
	"log"
	"net"
	"sync"
	"time"
)

// FrameSender manages a TCP connection to a remote server for sending camera
// frames (NALUs). It is safe for concurrent use and supports auto-reconnection.
type FrameSender struct {
	conn     net.Conn
	mu       sync.Mutex
	cameraID string
	tenantID string
	address  string
	closed   bool // set by Close; a closed sender never reconnects
}

// errSenderClosed is returned by SendNALU after Close.
var errSenderClosed = fmt.Errorf("frame sender is closed")

// NewFrameSender creates a new FrameSender. Instead of failing immediately
// if the server is down, it attempts an initial connection and logs/retries in background
// or allows lazy connection on the first frame.
func NewFrameSender(address string, cameraID string, tenantID string) (*FrameSender, error) {
	sender := &FrameSender{
		address:  address,
		cameraID: cameraID,
		tenantID: tenantID,
	}

	if err := sender.connect(); err != nil {
		log.Printf("WARNING: Could not connect immediately to %s for camera [%s]: %v. Will retry in background...", address, cameraID, err)
	}

	return sender, nil
}

// connect establishes the TCP connection and performs the handshake.
func (fs *FrameSender) connect() error {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	if fs.closed {
		return errSenderClosed
	}
	if fs.conn != nil {
		return nil // it is connected
	}

	conn, err := net.DialTimeout("tcp", fs.address, 3*time.Second)
	if err != nil {
		return err
	}

	fs.conn = conn

	if err := fs.sendHandshakeLocked(); err != nil {
		fs.conn.Close()
		fs.conn = nil
		return err
	}

	log.Printf("TCP connection & handshake established with %s for camera [%s]", fs.address, fs.cameraID)
	return nil
}

// sendHandshakeLocked sends the length and identifiers (tenant & camera).
// Assumes fs.mu is already locked.
func (fs *FrameSender) sendHandshakeLocked() error {
	tenantBytes := []byte(fs.tenantID)
	camBytes := []byte(fs.cameraID)

	buf := make([]byte, 0, 8+len(tenantBytes)+len(camBytes))
	var tmp [4]byte

	binary.BigEndian.PutUint32(tmp[:], uint32(len(tenantBytes)))
	buf = append(buf, tmp[:]...)
	buf = append(buf, tenantBytes...)

	binary.BigEndian.PutUint32(tmp[:], uint32(len(camBytes)))
	buf = append(buf, tmp[:]...)
	buf = append(buf, camBytes...)

	fs.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	_, err := fs.conn.Write(buf)
	fs.conn.SetWriteDeadline(time.Time{})
	return err
}

// SendNALU sends a single H.264 fragment, with automatic reconnection if disconnected.
func (fs *FrameSender) SendNALU(nalu []byte) error {
	fs.mu.Lock()
	if fs.closed {
		fs.mu.Unlock()
		return errSenderClosed
	}
	// if there is no any activate connection, it try again
	if fs.conn == nil {
		fs.mu.Unlock()
		if err := fs.connect(); err != nil {
			return fmt.Errorf("reconnection failed: %w", err)
		}
		fs.mu.Lock()
	}

	length := uint32(len(nalu))
	header := make([]byte, 4)
	binary.BigEndian.PutUint32(header, length)

	fs.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	_, err := fs.conn.Write(header)
	if err == nil {
		_, err = fs.conn.Write(nalu)
	}
	fs.conn.SetWriteDeadline(time.Time{})

	if err != nil {
		if fs.conn != nil {
			fs.conn.Close()
			fs.conn = nil
		}
		fs.mu.Unlock()
		return fmt.Errorf("failed to send NALU (connection reset): %w", err)
	}

	fs.mu.Unlock()
	return nil
}

// Close closes the underlying TCP connection for good: later SendNALU calls return an
// error instead of reconnecting.
func (fs *FrameSender) Close() error {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	fs.closed = true
	if fs.conn != nil {
		err := fs.conn.Close()
		fs.conn = nil
		return err
	}
	return nil
}
