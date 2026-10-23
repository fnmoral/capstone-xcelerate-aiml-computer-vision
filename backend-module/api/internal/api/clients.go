package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// GatewayCamera is a camera as gateway-back returns it.
type GatewayCamera struct {
	ID        string    `json:"id"`
	TenantID  string    `json:"tenant_id"`
	Name      string    `json:"name"`
	RTSPURL   string    `json:"rtsp_url"`
	Username  string    `json:"username"`
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"created_at"`
}

// MLCamera is a camera's live state as ml-service's viewer reports it.
type MLCamera struct {
	ID            string           `json:"id"`
	People        []map[string]any `json:"people"`
	LastFrameAgeS *float64         `json:"last_frame_age_s"`
}

// upstreamError is a non-2xx response from gateway-back or ml-service.
type upstreamError struct {
	Service string
	Status  int
	Body    string
}

func (e *upstreamError) Error() string {
	return fmt.Sprintf("%s returned %d: %s", e.Service, e.Status, strings.TrimSpace(e.Body))
}

type httpClient struct {
	name string
	base string
	http *http.Client
}

func newClient(name, base string, timeout time.Duration) *httpClient {
	return &httpClient{name: name, base: strings.TrimRight(base, "/"), http: &http.Client{Timeout: timeout}}
}

// do sends a JSON request and decodes a JSON response into out (if not nil).
func (c *httpClient) do(ctx context.Context, method, path string, body, out any) error {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, rd)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("%s unreachable: %w", c.name, err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode >= 300 {
		return &upstreamError{Service: c.name, Status: resp.StatusCode, Body: errorText(data)}
	}
	if out != nil && len(data) > 0 {
		return json.Unmarshal(data, out)
	}
	return nil
}

// errorText pulls {"Error": "..."} / {"error": "..."} out of an upstream body.
func errorText(data []byte) string {
	var m map[string]any
	if json.Unmarshal(data, &m) == nil {
		for _, k := range []string{"Error", "error", "message"} {
			if s, ok := m[k].(string); ok {
				return s
			}
		}
	}
	return string(data)
}

// gateway wraps gateway-back's /gateway/actions API.
type gateway struct{ *httpClient }

func (g gateway) cameras(ctx context.Context) ([]GatewayCamera, error) {
	var out []GatewayCamera
	err := g.do(ctx, http.MethodGet, "/gateway/actions/cameras", nil, &out)
	return out, err
}

func (g gateway) addCamera(ctx context.Context, name, rtspURL, user, pass string) (*GatewayCamera, error) {
	var out GatewayCamera
	err := g.do(ctx, http.MethodPost, "/gateway/actions/cameras",
		map[string]string{"name": name, "rtsp_url": rtspURL, "username": user, "password": pass}, &out)
	return &out, err
}

func (g gateway) camera(ctx context.Context, action, id string) (*GatewayCamera, error) {
	var out GatewayCamera
	err := g.do(ctx, http.MethodPost, "/gateway/actions/cameras/"+url.PathEscape(id)+"/"+action, nil, &out)
	return &out, err
}

func (g gateway) deleteCamera(ctx context.Context, id string) error {
	return g.do(ctx, http.MethodDelete, "/gateway/actions/cameras/"+url.PathEscape(id), nil, nil)
}

// ml wraps ml-service's viewer API.
type ml struct{ *httpClient }

func (m ml) state(ctx context.Context) (map[string]MLCamera, error) {
	var st struct {
		Cameras []MLCamera `json:"cameras"`
	}
	if err := m.do(ctx, http.MethodGet, "/api/state", nil, &st); err != nil {
		return nil, err
	}
	out := make(map[string]MLCamera, len(st.Cameras))
	for _, c := range st.Cameras {
		out[c.ID] = c
	}
	return out, nil
}
