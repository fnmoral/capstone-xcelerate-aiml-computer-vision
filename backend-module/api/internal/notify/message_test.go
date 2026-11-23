package notify

import (
	"strings"
	"testing"
)

func TestBuildMessage(t *testing.T) {
	p := EmailProvider{FromName: "FallGuard", FromEmail: "app@example.com"}
	plain := string(buildMessage(p, Email{To: "a@b.co", Subject: "Hi", Text: "line one\nline two"}))
	for _, want := range []string{"Message-ID: <", "@example.com>", "Date: ", "Content-Type: text/plain; charset=utf-8", "line one\r\nline two"} {
		if !strings.Contains(plain, want) {
			t.Errorf("plain message misses %q:\n%s", want, plain)
		}
	}
	both := string(buildMessage(p, Email{To: "a@b.co", Subject: "Hi", Text: "text body", HTML: "<p>html body</p>"}))
	for _, want := range []string{"multipart/alternative; boundary=", "text/plain", "text/html", "text body", "<p>html body</p>"} {
		if !strings.Contains(both, want) {
			t.Errorf("multipart message misses %q", want)
		}
	}
	if strings.Count(both, "--fg-") != 3 {
		t.Errorf("want 2 parts and a closing boundary:\n%s", both)
	}
}
