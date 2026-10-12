package hub

// Client represents a frontend WebSocket subscriber.
type Client struct {
	ID       string
	SendChan chan []byte
	TenantID string
	CameraID string
}

// NewClient creates a new instance of a subscriber Client.
func NewClient(id, tenantID, cameraID string) *Client {
	return &Client{
		ID:       id,
		SendChan: make(chan []byte, 256),
		TenantID: tenantID,
		CameraID: cameraID,
	}
}
