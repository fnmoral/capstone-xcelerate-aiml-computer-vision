// Package network provides utilities for sending camera frames over TCP to a
// remote server, including a FrameSender that handles the handshake protocol
// and NALU transmission with automatic reconnection.
//
// Wire protocol (gateway -> stream-hub):
//
//	Handshake (once per connection):
//	  [4 bytes BE uint32: len(tenantID)][tenantID]
//	  [4 bytes BE uint32: len(cameraID)][cameraID]
//
//	Frame (one per NALU):
//	  [4 bytes BE uint32: len(NALU)]
//	  [8 bytes BE int64:  PTS, Unix epoch in milliseconds]
//	  [NALU bytes]
//
// All NALUs that belong to the same access unit (SPS, PPS, SEI and the slices
// of one picture) MUST carry the same PTS, so downstream consumers (ML module,
// frontend) can match detections with the exact picture they were computed on.
package network

import (
	"encoding/binary"
	"errors"
	"fmt"
	"log"
	"net"
	"sync"
	"time"
)

const (
	// frameHeaderSize is 4 bytes of NALU length + 8 bytes of PTS.
	frameHeaderSize = 12

	dialTimeout  = 3 * time.Second
	writeTimeout = 5 * time.Second
)

// errSenderClosed is returned by the send methods after Close.
var errSenderClosed = errors.New("frame sender is closed")

// NowPTS returns the current wall-clock time as a PTS (Unix epoch, ms).
// Call it once per access unit at capture time, never once per NALU.
func NowPTS() int64 {
	return time.Now().UnixMilli()
}

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

// NewFrameSender creates a new FrameSender. Instead of failing immediately
// if the server is down, it attempts an initial connection and, if that
// fails, connects lazily on the next send.
func NewFrameSender(address string, cameraID string, tenantID string) (*FrameSender, error) {
	sender := &FrameSender{
		address:  address,
		cameraID: cameraID,
		tenantID: tenantID,
	}

	if err := sender.connect(); err != nil {
		log.Printf("WARNING: Could not connect immediately to %s for camera [%s]: %v. Will retry on next frame...", address, cameraID, err)
	}

	return sender, nil
}

// connect establishes the TCP connection and performs the handshake.
func (fs *FrameSender) connect() error {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	return fs.connectLocked()
}

// connectLocked dials and sends the handshake if there is no live connection.
// Assumes fs.mu is already locked.
func (fs *FrameSender) connectLocked() error {
	if fs.closed {
		return errSenderClosed
	}
	if fs.conn != nil {
		return nil // already connected
	}

	conn, err := net.DialTimeout("tcp", fs.address, dialTimeout)
	if err != nil {
		return err
	}
	fs.conn = conn

	if err := fs.sendHandshakeLocked(); err != nil {
		fs.dropConnLocked()
		return err
	}

	log.Printf("TCP connection & handshake established with %s for camera [%s]", fs.address, fs.cameraID)
	return nil
}

// dropConnLocked closes and forgets the current connection.
// Assumes fs.mu is already locked.
func (fs *FrameSender) dropConnLocked() {
	if fs.conn != nil {
		fs.conn.Close()
		fs.conn = nil
	}
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

	fs.conn.SetWriteDeadline(time.Now().Add(writeTimeout))
	_, err := fs.conn.Write(buf)
	fs.conn.SetWriteDeadline(time.Time{})
	return err
}

// SendNALU sends a single H.264 NALU stamped with pts (Unix epoch, ms).
// If several NALUs form one picture, prefer SendAccessUnit, or make sure
// every call for that picture uses the same pts.
func (fs *FrameSender) SendNALU(nalu []byte, pts int64) error {
	return fs.SendAccessUnit([][]byte{nalu}, pts)
}

// SendAccessUnit sends every NALU of one picture with the same pts in a
// single write, so a disconnection can never split a picture across two
// connections. Reconnects automatically if there is no live connection.
func (fs *FrameSender) SendAccessUnit(nalus [][]byte, pts int64) error {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	if err := fs.connectLocked(); err != nil {
		if errors.Is(err, errSenderClosed) {
			return err
		}
		return fmt.Errorf("reconnection failed: %w", err)
	}

	headers := make([]byte, frameHeaderSize*len(nalus))
	bufs := make(net.Buffers, 0, 2*len(nalus))

	for i, nalu := range nalus {
		if len(nalu) == 0 {
			continue
		}
		h := headers[i*frameHeaderSize : (i+1)*frameHeaderSize]
		binary.BigEndian.PutUint32(h[0:4], uint32(len(nalu)))
		binary.BigEndian.PutUint64(h[4:12], uint64(pts))
		bufs = append(bufs, h, nalu)
	}

	if len(bufs) == 0 {
		return nil
	}

	fs.conn.SetWriteDeadline(time.Now().Add(writeTimeout))
	_, err := bufs.WriteTo(fs.conn) // writev: headers + payloads in one syscall
	if err != nil {
		fs.dropConnLocked()
		return fmt.Errorf("failed to send access unit (connection reset): %w", err)
	}
	fs.conn.SetWriteDeadline(time.Time{})

	return nil
}

// Close closes the underlying TCP connection for good: later send calls
// return an error instead of reconnecting.
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
