package notify

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestRender(t *testing.T) {
	got := Render("Fall on {{camera}} at {{ time }} {{unknown}}", map[string]string{"camera": "CAM-1", "time": "10:00"})
	if got != "Fall on CAM-1 at 10:00 {{unknown}}" {
		t.Errorf("got %q", got)
	}
}

func TestMessageUsesCustomOrDefault(t *testing.T) {
	v := map[string]string{"camera": "CAM-1", "severity_upper": "HIGH"}
	c := DefaultConfig()
	subject, _, _ := c.Message("alert", v)
	if subject != "[HIGH] Fall detected: CAM-1" {
		t.Errorf("default subject = %q", subject)
	}
	c.Templates["alert"] = Template{Custom: true, Subject: "Help needed at {{camera}}", Body: ""}
	subject, body, _ := c.Message("alert", v)
	if subject != "Help needed at CAM-1" {
		t.Errorf("custom subject = %q", subject)
	}
	if !strings.Contains(body, "A fall was detected") {
		t.Error("an empty custom body should fall back to the default body")
	}
	c.Templates["alert"] = Template{Custom: false, Subject: "ignored"}
	if subject, _, _ = c.Message("alert", v); subject == "ignored" {
		t.Error("custom=false must use the default template")
	}
}

func TestValidate(t *testing.T) {
	c := DefaultConfig()
	c.EmailRecipients = []Recipient{{Name: "Ops", Address: " Ops@Example.com ", Severities: []string{"high", "high"}, Enabled: true}}
	c.SMSRecipients = []Recipient{{Address: "+1 (416) 555-0123", Severities: []string{"critical"}, Enabled: true}}
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	if c.EmailRecipients[0].Address != "ops@example.com" || len(c.EmailRecipients[0].Severities) != 1 {
		t.Errorf("email recipient not cleaned: %+v", c.EmailRecipients[0])
	}
	if c.SMSRecipients[0].Address != "+14165550123" {
		t.Errorf("phone not cleaned: %q", c.SMSRecipients[0].Address)
	}
	bad := []func(*Config){
		func(c *Config) { c.SMSRecipients = []Recipient{{Address: "4165550123"}} },
		func(c *Config) { c.EmailRecipients = []Recipient{{Address: "not-an-email"}} },
		func(c *Config) { c.Matrix["email"]["low"] = true },
		func(c *Config) { c.Matrix["pager"] = map[string]bool{} },
		func(c *Config) { c.FollowUps["exploded"] = true },
		func(c *Config) { c.AppURL = "javascript:alert(1)" },
		func(c *Config) {
			c.EmailRecipients = []Recipient{{Address: "a@b.co"}, {Address: "A@b.co"}}
		},
	}
	for i, f := range bad {
		c := DefaultConfig()
		f(&c)
		if err := c.Validate(); err == nil {
			t.Errorf("case %d should be refused", i)
		}
	}
}

func TestRecipientWants(t *testing.T) {
	r := Recipient{Severities: []string{"critical"}, Enabled: true}
	if r.Wants("high") || !r.Wants("critical") {
		t.Error("severity filter broken")
	}
	r.Enabled = false
	if r.Wants("critical") {
		t.Error("disabled recipient must get nothing")
	}
}

func TestBox(t *testing.T) {
	b, _ := NewBox("secret-1")
	sealed, err := b.Seal("p@ss")
	if err != nil || sealed == "p@ss" || !strings.HasPrefix(sealed, "v1:") {
		t.Fatalf("seal: %q %v", sealed, err)
	}
	if got, err := b.Open(sealed); err != nil || got != "p@ss" {
		t.Errorf("open: %q %v", got, err)
	}
	other, _ := NewBox("secret-2")
	if _, err := other.Open(sealed); err == nil {
		t.Error("a different key must not decrypt")
	}
	if s, _ := b.Seal(""); s != "" {
		t.Error("empty stays empty")
	}
}

func TestSendLogged(t *testing.T) {
	if res, err := SendEmail(context.Background(), EmailProvider{Type: "log"}, Email{To: "a@b.co", Subject: "s", Text: "t"}); err != nil || res != Logged {
		t.Errorf("email log: %v %v", res, err)
	}
	if res, err := SendSMS(context.Background(), SMSProvider{Type: "log"}, "+14165550123", "hi"); err != nil || res != Logged {
		t.Errorf("sms log: %v %v", res, err)
	}
	if _, err := SendSMS(context.Background(), SMSProvider{Type: "log"}, "555", "hi"); err == nil {
		t.Error("bad number should fail")
	}
	if _, err := SendEmail(context.Background(), EmailProvider{Type: "smtp"}, Email{To: "a@b.co"}); err == nil {
		t.Error("smtp without host should fail")
	}
}

func TestSendTwilio(t *testing.T) {
	var gotPath, gotUser, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotUser, _, _ = r.BasicAuth()
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		if strings.Contains(gotBody, "fail") {
			w.WriteHeader(400)
			_, _ = w.Write([]byte(`{"message":"The 'To' number is not valid."}`))
			return
		}
		w.WriteHeader(201)
		_, _ = w.Write([]byte(`{"sid":"SM1"}`))
	}))
	defer srv.Close()
	old := twilioBase
	twilioBase = srv.URL
	defer func() { twilioBase = old }()

	p := SMSProvider{Type: "twilio", AccountSID: "AC123", FromNumber: "+15005550006", authToken: "tok"}
	res, err := SendSMS(context.Background(), p, "+14165550123", "hello")
	if err != nil || res != Sent {
		t.Fatalf("send: %v %v", res, err)
	}
	form, _ := url.ParseQuery(gotBody)
	if gotPath != "/2010-04-01/Accounts/AC123/Messages.json" || gotUser != "AC123" || form.Get("To") != "+14165550123" || form.Get("Body") != "hello" {
		t.Errorf("request: %s %s %v", gotPath, gotUser, form)
	}
	if _, err := SendSMS(context.Background(), p, "+14165550123", "fail"); err == nil || !strings.Contains(err.Error(), "not valid") {
		t.Errorf("Twilio error should be passed on, got %v", err)
	}
}
