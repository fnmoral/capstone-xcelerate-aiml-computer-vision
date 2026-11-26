package api

import (
	"testing"
	"time"
)

// One missed check doesn't make an online gateway offline (it would switch Automatic to
// another gateway and mark every camera inactive); two in a row do.
func TestNextOnlineMark(t *testing.T) {
	now := time.Now()
	m := nextOnlineMark(onlineMark{}, true, now)
	if !m.ok || m.fails != 0 {
		t.Fatalf("answering: %+v", m)
	}
	m = nextOnlineMark(m, false, now)
	if !m.ok || m.fails != 1 {
		t.Fatalf("one miss after online should stay online: %+v", m)
	}
	m = nextOnlineMark(m, false, now)
	if m.ok || m.fails != 2 {
		t.Fatalf("two misses in a row should be offline: %+v", m)
	}
	m = nextOnlineMark(m, true, now)
	if !m.ok || m.fails != 0 {
		t.Fatalf("answering again should be online at once: %+v", m)
	}
	if m := nextOnlineMark(onlineMark{}, false, now); m.ok {
		t.Fatalf("never answered should be offline: %+v", m)
	}
}
