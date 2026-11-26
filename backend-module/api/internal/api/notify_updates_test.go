package api

import (
	"testing"

	"backend-api/internal/notify"
)

// Updates (recovered, resolved, false alarm) go to every recipient who ticked them, on each
// channel switched on for them in "When to notify", and only to switched-on recipients.
func TestUpdateMessages(t *testing.T) {
	cfg := notify.DefaultConfig()
	cfg.Matrix["email"]["resolved"] = true
	cfg.Matrix["sms"]["resolved"] = false // master switch off for SMS
	cfg.EmailRecipients = []notify.Recipient{
		{Address: "nurse@x.co", Severities: []string{"high", "resolved"}, Enabled: true},
		{Address: "manager@x.co", Severities: []string{"resolved"}, Enabled: true}, // updates only
		{Address: "off@x.co", Severities: []string{"resolved"}, Enabled: false},
		{Address: "alerts-only@x.co", Severities: []string{"critical"}, Enabled: true},
	}
	cfg.SMSRecipients = []notify.Recipient{{Address: "+14165550123", Severities: []string{"resolved"}, Enabled: true}}
	calls := 0
	msgs := updateMessages(cfg, "resolved", func() (string, string, string) { calls++; return "subj", "body", "sms" })
	got := map[string]bool{}
	for _, m := range msgs {
		got[m.Channel+":"+m.Recipient] = true
		if m.Event != "resolved" || (m.Channel == "email" && (m.Subject == nil || *m.Subject != "subj")) {
			t.Errorf("bad message %+v", m)
		}
	}
	want := map[string]bool{"email:nurse@x.co": true, "email:manager@x.co": true}
	if len(got) != len(want) || !got["email:nurse@x.co"] || !got["email:manager@x.co"] {
		t.Fatalf("got %v, want %v", got, want)
	}
	if calls != 1 {
		t.Errorf("message built %d times, want once", calls)
	}
	cfg.Matrix["email"]["resolved"] = false
	if m := updateMessages(cfg, "resolved", func() (string, string, string) { return "", "", "" }); len(m) != 0 {
		t.Errorf("master switch off should send nothing, got %d", len(m))
	}
}
