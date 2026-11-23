package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"backend-api/internal/store"
)

func TestPickGateway(t *testing.T) {
	t1, t2 := time.Now().Add(-time.Minute), time.Now()
	cloud := store.Gateway{ID: "cloud", Kind: store.GatewayCloud}
	office := store.Gateway{ID: "office", Kind: store.GatewayOnsite, LastSeenAt: &t1}
	lobby := store.Gateway{ID: "lobby", Kind: store.GatewayOnsite, LastSeenAt: &t2}
	list := []store.Gateway{cloud, office, lobby}
	id := func(s string) *string { return &s }

	cases := []struct {
		name       string
		list       []store.Gateway
		online     map[string]bool
		chosen     *string
		want       string
		wantChosen bool
	}{
		{"automatic: an online on-site gateway, the one seen last", list, map[string]bool{"cloud": true, "office": true, "lobby": true}, nil, "lobby", false},
		{"automatic: offline on-site gateways are skipped", list, map[string]bool{"cloud": true, "office": true}, nil, "office", false},
		{"automatic: no on-site gateway online -> cloud", list, map[string]bool{"cloud": true}, nil, "cloud", false},
		{"automatic: cloud even offline when nothing answers", list, map[string]bool{}, nil, "cloud", false},
		{"chosen: kept while offline", list, map[string]bool{"cloud": true}, id("office"), "office", true},
		{"chosen but removed -> automatic", list, map[string]bool{"cloud": true}, id("gone"), "cloud", false},
		{"only an offline on-site gateway", []store.Gateway{office}, map[string]bool{}, nil, "office", false},
	}
	for _, c := range cases {
		got, chosen := pickGateway(c.list, c.online, c.chosen)
		if got == nil || got.ID != c.want || chosen != c.wantChosen {
			gotID := "<nil>"
			if got != nil {
				gotID = got.ID
			}
			t.Errorf("%s: got %s (chosen %v), want %s (chosen %v)", c.name, gotID, chosen, c.want, c.wantChosen)
		}
	}
	if got, _ := pickGateway(nil, nil, nil); got != nil {
		t.Errorf("no gateways: got %v, want nil (GATEWAY_URL)", got.ID)
	}
}

func TestPhoneCamerasOnlyWithTheCloudGateway(t *testing.T) {
	cloud := &store.Gateway{Kind: store.GatewayCloud}
	onsite := &store.Gateway{Kind: store.GatewayOnsite}
	for _, c := range []struct {
		inUse *store.Gateway
		relay string
		want  bool
	}{
		{cloud, "rtmps://x:1936", true},
		{onsite, "rtmps://x:1936", false},
		{nil, "rtmps://x:1936", true}, // no gateways signed up (local stack): as before
		{cloud, "", false},
	} {
		if got := (gatewayState{inUse: c.inUse}).phoneCamerasOn(c.relay); got != c.want {
			t.Errorf("in use %+v, relay %q: got %v, want %v", c.inUse, c.relay, got, c.want)
		}
	}
}

func TestGatewaySignupOnlyFromPrivateDirectCallers(t *testing.T) {
	for _, c := range []struct {
		remote, xff string
		want        bool
	}{
		{"172.18.0.5:41000", "", true},             // Docker network / SSH tunnel
		{"127.0.0.1:41000", "", true},              // the server itself
		{"172.18.0.9:41000", "203.0.113.7", false}, // through nginx from the internet
		{"203.0.113.7:41000", "", false},           // a public address
	} {
		ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
		ctx.Request = httptest.NewRequest(http.MethodPost, "/api/gateway/add", nil)
		ctx.Request.RemoteAddr = c.remote
		if c.xff != "" {
			ctx.Request.Header.Set("X-Forwarded-For", c.xff)
		}
		if got := gatewayCaller(ctx); got != c.want {
			t.Errorf("%s xff=%q: got %v, want %v", c.remote, c.xff, got, c.want)
		}
	}
}
