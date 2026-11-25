package api

import (
	"strings"
	"testing"
)

// The copy of an account email kept for Settings > Emails sent must never hold its sign-in
// link: anyone allowed to view emails could otherwise use someone else's invitation or reset.
func TestAccountEmailPreviewHasNoPersonalLink(t *testing.T) {
	s := &Server{cfg: Config{AppURL: "https://fallguard.example"}}
	link := "https://fallguard.example/invite/SECRET-TOKEN-123"
	m := s.accountEmail(nil, "ada@example.com", "You're invited", accountMail{
		Greeting: "Hello,", Lines: []string{"Join Maple Grove."}, Button: "Accept invitation", Link: link, Note: "Expires in 7 days.",
	})
	if !strings.Contains(m.HTML, link) || !strings.Contains(m.Text, link) {
		t.Fatal("the email itself must carry the link")
	}
	if m.Preview == "" || strings.Contains(m.Preview, "SECRET-TOKEN-123") {
		t.Fatalf("the kept copy must exist and leave the link out:\n%s", m.Preview)
	}
	for _, want := range []string{"Join Maple Grove.", "Accept invitation", "not kept"} {
		if !strings.Contains(m.Preview, want) {
			t.Errorf("kept copy is missing %q", want)
		}
	}
}

// Alert emails: the button comes right after the message, the "Open the incident: <link>"
// line leaves the body and the link is repeated in small print at the bottom; the plain-text
// version keeps everything. Both say replies are not read.
func TestAlertEmailButtonThenSmallLink(t *testing.T) {
	link := "https://fallguard.example/events/abc"
	body := "A fall was detected by FallGuard.\n\nSeverity: HIGH\n\nOpen the incident: " + link + "\n\n— FallGuard"
	m := alertEmail("https://fallguard.example", "a@example.com", "Fall", body, nil, true)
	if strings.Contains(m.HTML, "Open the incident:") {
		t.Error("the link line should leave the HTML body")
	}
	button := strings.Index(m.HTML, ">Open in FallGuard</a>")
	small := strings.Index(m.HTML, "Button not working?")
	if button < 0 || small < button || !strings.Contains(m.HTML[small:], link) {
		t.Errorf("want the button, then the link in small print (button %d, small %d)", button, small)
	}
	if !strings.Contains(m.HTML, `href="`+link+`"`) {
		t.Error("the button must open the incident")
	}
	if !strings.Contains(m.Text, "Open the incident: "+link) || !strings.Contains(m.Text, "no-reply") ||
		!strings.Contains(m.HTML, "no-reply") {
		t.Error("plain text keeps the link; both versions carry the no-reply note")
	}
	if !strings.Contains(m.HTML, "Fall Detection for Workplaces") {
		t.Error("footer tagline")
	}
}

// Message times use the organization's zone, else the server default, never "" (= UTC).
func TestMessageZone(t *testing.T) {
	s := &Server{cfg: Config{DefaultTimezone: "America/Toronto"}}
	for org, want := range map[string]string{"": "America/Toronto", "Europe/Paris": "Europe/Paris", "Not/AZone": "America/Toronto"} {
		if got := s.messageZone(org).String(); got != want {
			t.Errorf("org %q: got %s, want %s", org, got, want)
		}
	}
}
