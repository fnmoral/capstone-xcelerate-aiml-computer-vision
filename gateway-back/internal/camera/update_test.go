package camera

import (
	"errors"
	"testing"

	"gateway-back/internal/stream"
)

// memRepo keeps cameras in memory (only what UpdateCamera uses).
type memRepo struct{ cams map[string]*Camera }

func (m *memRepo) Create(cam *Camera) error { m.cams[cam.ID] = cam; return nil }
func (m *memRepo) FindByID(id string) (*Camera, error) {
	if c, ok := m.cams[id]; ok {
		cp := *c
		return &cp, nil
	}
	return nil, nil
}
func (m *memRepo) FindAll() ([]Camera, error)      { return nil, nil }
func (m *memRepo) Count() (int64, error)           { return int64(len(m.cams)), nil }
func (m *memRepo) CountStreaming() (int64, error)  { return 0, nil }
func (m *memRepo) Delete(id string) error          { delete(m.cams, id); return nil }
func (m *memRepo) UpdateStatus(id, s string) error { m.cams[id].Status = s; return nil }
func (m *memRepo) UpdateConnection(id, u, user, pass string) error {
	c, ok := m.cams[id]
	if !ok {
		return ErrCameraNotFound
	}
	c.RTSPURL, c.Username, c.Password = u, user, pass
	return nil
}

func ptr(s string) *string { return &s }

// A paused camera: UpdateCamera saves the change without connecting to anything.
func newPaused() (*memRepo, Service) {
	repo := &memRepo{cams: map[string]*Camera{"cam1": {
		ID: "cam1", Name: "Hall", RTSPURL: "rtsp://10.0.0.5:554/old", Username: "admin", Password: "secret", Status: StatusPaused,
	}}}
	return repo, NewService(repo, stream.NewStreamManager("127.0.0.1:1"))
}

func TestUpdateCameraChangesAddressAndKeepsPassword(t *testing.T) {
	repo, svc := newPaused()
	cam, err := svc.UpdateCamera("cam1", UpdateCameraDTO{RTSPURL: ptr("rtsp://192.168.1.64:554/Streaming/Channels/101")})
	if err != nil {
		t.Fatal(err)
	}
	got := repo.cams["cam1"]
	if got.RTSPURL != "rtsp://192.168.1.64:554/Streaming/Channels/101" || got.Username != "admin" || got.Password != "secret" {
		t.Fatalf("saved %+v", got)
	}
	if cam.ID != "cam1" || cam.Status != StatusPaused {
		t.Fatalf("returned %+v", cam)
	}
}

func TestUpdateCameraNewLogin(t *testing.T) {
	repo, svc := newPaused()
	if _, err := svc.UpdateCamera("cam1", UpdateCameraDTO{Username: ptr("viewer"), Password: ptr("n3w")}); err != nil {
		t.Fatal(err)
	}
	if got := repo.cams["cam1"]; got.Username != "viewer" || got.Password != "n3w" || got.RTSPURL != "rtsp://10.0.0.5:554/old" {
		t.Fatalf("saved %+v", got)
	}
}

func TestUpdateCameraEmptyUsernameRemovesLogin(t *testing.T) {
	repo, svc := newPaused()
	if _, err := svc.UpdateCamera("cam1", UpdateCameraDTO{Username: ptr("")}); err != nil {
		t.Fatal(err)
	}
	if got := repo.cams["cam1"]; got.Username != "" || got.Password != "" {
		t.Fatalf("login kept: %+v", got)
	}
}

func TestUpdateCameraRejectsBadURL(t *testing.T) {
	repo, svc := newPaused()
	for _, bad := range []string{"http://10.0.0.5/x", "rtsp://", "not a url"} {
		if _, err := svc.UpdateCamera("cam1", UpdateCameraDTO{RTSPURL: ptr(bad)}); !errors.Is(err, ErrInvalidRTSPURL) {
			t.Errorf("%q: got %v", bad, err)
		}
	}
	if repo.cams["cam1"].RTSPURL != "rtsp://10.0.0.5:554/old" {
		t.Fatal("address changed by a rejected update")
	}
}

func TestUpdateCameraUnknown(t *testing.T) {
	_, svc := newPaused()
	if _, err := svc.UpdateCamera("nope", UpdateCameraDTO{Username: ptr("x")}); !errors.Is(err, ErrCameraNotFound) {
		t.Fatalf("got %v", err)
	}
}
