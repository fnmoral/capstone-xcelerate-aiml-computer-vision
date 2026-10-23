package camera

import (
	"testing"

	"gateway-back/internal/rtsp"
)

func TestBuildRTSPURL(t *testing.T) {
	const hik = "rtsp://192.168.1.64:554/Streams/Channels/101"
	cases := []struct {
		name, url, user, pass, want string
	}{
		{"adds credentials", hik, "admin", "Secret123", "rtsp://admin:Secret123@192.168.1.64:554/Streams/Channels/101"},
		{"escapes special characters", hik, "admin", "p@ss:w/rd#1?", "rtsp://admin:p%40ss%3Aw%2Frd%231%3F@192.168.1.64:554/Streams/Channels/101"},
		{"no username: unchanged", hik, "", "", hik},
		{"credentials already in URL: unchanged", "rtsp://u:p@cam:554/x", "admin", "other", "rtsp://u:p@cam:554/x"},
		{"keeps the query string", "rtsp://cam:554/cam/realmonitor?channel=1&subtype=0", "admin", "pw",
			"rtsp://admin:pw@cam:554/cam/realmonitor?channel=1&subtype=0"},
	}
	for _, c := range cases {
		if got := buildRTSPURL(c.url, c.user, c.pass); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

func TestRedactHidesPassword(t *testing.T) {
	full := buildRTSPURL("rtsp://192.168.1.64:554/Streams/Channels/101", "admin", "p@ss:w/rd#1?")
	got := rtsp.Redact(full)
	if want := "rtsp://admin:xxxxx@192.168.1.64:554/Streams/Channels/101"; got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
	if plain := "rtsp://cam:554/x"; rtsp.Redact(plain) != plain {
		t.Fatalf("URL without credentials changed: %q", rtsp.Redact(plain))
	}
}
