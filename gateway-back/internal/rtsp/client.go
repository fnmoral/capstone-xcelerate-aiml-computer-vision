package rtsp

import (
	"context"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/bluenviron/gortsplib/v5"
	"github.com/bluenviron/gortsplib/v5/pkg/base"
	"github.com/bluenviron/gortsplib/v5/pkg/description"
	"github.com/bluenviron/gortsplib/v5/pkg/format"
	"github.com/pion/rtp"

	"gateway-back/internal/extractor"
	"gateway-back/internal/network"
)

type RTSPClient struct {
	ID        string
	RTSPURL   string
	sender    *network.FrameSender
	extractor *extractor.KeyframeExtractor

	mu        sync.Mutex
	isRunning bool

	ctx    context.Context
	cancel context.CancelFunc
}

// NewRTSPClient creates a new RTSPClient instance with the given ID, RTSP URL,
// and FrameSender. The client does not connect automatically;
// Start must be called to do so.
func NewRTSPClient(id, rtspURL string, sender *network.FrameSender) *RTSPClient {
	ctx, cancel := context.WithCancel(context.Background())
	return &RTSPClient{
		ID:      id,
		RTSPURL: strings.TrimSpace(rtspURL),
		sender:  sender,
		ctx:     ctx,
		cancel:  cancel,
	}
}

// Start starts the RTSP client in the background.
//
// It launches the connectionLoop goroutine, which handles connecting, streaming,
// and automatically reconnecting if the connection is lost.
//
// Returns an error if the client was already running.
func (c *RTSPClient) Start() error {
	c.mu.Lock()
	if c.isRunning {
		c.mu.Unlock()
		return fmt.Errorf("Camera [%s] is already running: ", c.ID)
	}
	c.isRunning = true
	c.mu.Unlock()

	// Launch the connection and reconnection loop in the background
	go c.connectionLoop()

	return nil
}

// connectionLoop manages the RTSP connection lifecycle.
//
// It runs in a goroutine and is responsible for:
//   - Attempting to connect via connectAndStream.
//   - Retrying after connection errors (waits 5 seconds).
//   - Reconnecting after a successful connection ends (waits 3 seconds).
//   - Terminating when isRunning becomes false (via a Stop call).
func (c *RTSPClient) connectionLoop() {
	for {
		c.mu.Lock()
		if !c.isRunning {
			c.mu.Unlock()
			break
		}
		c.mu.Unlock()

		log.Printf("[%s] Attempting to connect to: %s", c.ID, c.RTSPURL)

		err := c.connectAndStream()

		// Check if it was stopped intentionally
		c.mu.Lock()
		running := c.isRunning
		c.mu.Unlock()

		if !running {
			break
		}

		if err != nil {
			log.Printf("[%s] Connection error: %v. Retrying in 5 seconds...", c.ID, err)
			time.Sleep(5 * time.Second)
			continue
		}

		log.Printf("[%s] Connection ended. Reconnecting in 3 seconds...", c.ID)
		time.Sleep(3 * time.Second)
	}
}

// connectAndStream establishes an RTSP connection, sets up the session, and
// begins receiving the video stream.
//
// It creates a new gortsplib client on each attempt (required to allow clean
// reconnections), performs the Describe, selects the video track, initializes
// the keyframe extractor, configures the Setup, registers the RTP packet
// callback, sends the initial SPS/PPS (if H.264), and executes Play.
//
// It blocks until the connection is lost or fails (client.Wait).
//
// Returns an error if any of the steps fail.
func (c *RTSPClient) connectAndStream() error {
	u, err := base.ParseURL(c.RTSPURL)
	if err != nil {
		return fmt.Errorf("Invalid RTSP URL: %w", err)
	}

	// We create a NEW Gortsplib client for each connection attempt
	client := &gortsplib.Client{
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
		Scheme:       u.Scheme,
		Host:         u.Host,
	}

	if err := client.Start(); err != nil {
		return fmt.Errorf("ERROR starting RTSP client: %w", err)
	}
	defer client.Close()

	desc, _, err := client.Describe(u)
	if err != nil {
		return fmt.Errorf("RTSP Describe error: %w", err)
	}

	var media *description.Media
	for _, m := range desc.Medias {
		if m.Type == description.MediaTypeVideo {
			media = m
			break
		}
	}

	if media == nil || len(media.Formats) == 0 {
		return fmt.Errorf("No valid video track found")
	}

	forma := media.Formats[0]

	ext, err := extractor.NewKeyframeExtractor(forma)
	if err != nil {
		log.Printf("[%s] Warning starting extractor: %v", c.ID, err)
	} else {
		c.extractor = ext
	}

	_, err = client.Setup(desc.BaseURL, media, 0, 0)
	if err != nil {
		return fmt.Errorf("RTSP Setup error: %w", err)
	}

	client.OnPacketRTP(media, forma, func(pkt *rtp.Packet) {
		if pkt == nil || c.extractor == nil || c.sender == nil {
			return
		}
		nalus, _ := c.extractor.ProcessPacket(pkt)
		for _, nalu := range nalus {
			if err := c.sender.SendNALU(nalu); err != nil {
				log.Printf("[%s] Error sending NALU: %v", c.ID, err)
			}
		}
	})

	if h264Format, ok := forma.(*format.H264); ok && c.sender != nil {
		if h264Format.SPS != nil {
			_ = c.sender.SendNALU(h264Format.SPS)
		}
		if h264Format.PPS != nil {
			_ = c.sender.SendNALU(h264Format.PPS)
		}
	}

	_, err = client.Play(nil)
	if err != nil {
		return fmt.Errorf("RTSP Play error: %w", err)
	}

	log.Printf("[%s] RTSP stream established successfully", c.ID)

	// Blocks here until the connection is lost or fails
	return client.Wait()
}

// Stop permanently stops the RTSP client.
//
// It marks isRunning as false, cancels the context, closes the FrameSender,
// and logs a message. Once stopped, the client will not reconnect again.
func (c *RTSPClient) Stop() {
	c.mu.Lock()
	c.isRunning = false
	c.mu.Unlock()

	c.cancel()

	if c.sender != nil {
		c.sender.Close()
	}

	log.Printf("RTSP client permanently stopped for camera [%s]", c.ID)
}

// IsRunning returns true if the RTSP client is currently running.
//
// It is safe for concurrent use.
func (c *RTSPClient) IsRunning() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.isRunning
}
