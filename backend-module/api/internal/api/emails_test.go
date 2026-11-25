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
