package notify

import (
	"errors"
	"fmt"
	"net/mail"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"
)

// Severities that can be notified, lowest first (ml-service raises a fall's severity the
// longer the person stays down: medium → high → critical).
var Severities = []string{"medium", "high", "critical"}

// Channels: in the app (bell, browser notification, sound), email, SMS.
var Channels = []string{"app", "email", "sms"}

// Events a message can be about. "alert" is a fall reaching a severity (first detection or
// escalation); the others are follow-ups on an alert that was already notified.
var Events = []string{"alert", "recovered", "false_alarm", "resolved"}

// FollowUps are the events after the alert.
var FollowUps = []string{"recovered", "false_alarm", "resolved"}

// Recipient gets email or SMS for what is ticked: alert severities (medium, high,
// critical) and updates (recovered, false_alarm, resolved). The JSON name stays
// "severities" for settings saved before updates could be ticked.
type Recipient struct {
	Name       string   `json:"name"`
	Address    string   `json:"address"`           // email address or +E.164 phone number
	UserID     *string  `json:"user_id,omitempty"` // set when picked from the members list
	Severities []string `json:"severities"`
	Enabled    bool     `json:"enabled"`
}

// updateChannels: the channels that can send updates (the app shows alerts only).
var updateChannels = []string{"email", "sms"}

// Template is the message for one event. Custom false = the default text is used.
type Template struct {
	Custom  bool   `json:"custom"`
	Subject string `json:"subject"`
	Body    string `json:"body"`
	SMS     string `json:"sms"`
}

// Config is an organization's notification settings.
type Config struct {
	// Matrix[channel][key]: whether that channel is used at that severity, and (email and
	// SMS) for that update: the master switches; recipients then tick what they get.
	Matrix          map[string]map[string]bool `json:"matrix"`
	EmailRecipients []Recipient                `json:"email_recipients"`
	SMSRecipients   []Recipient                `json:"sms_recipients"`
	// FollowUps[event]: an update is on for email or SMS. Kept for older settings and
	// readers; Normalize derives it from the matrix, which decides.
	FollowUps map[string]bool     `json:"follow_ups"`
	Templates map[string]Template `json:"templates"`
	// AppURL is the address of the web app, for links in messages.
	AppURL string `json:"app_url"`
}

// DefaultConfig: in-app at every severity, email and SMS off until recipients are added.
func DefaultConfig() Config {
	return Config{
		Matrix: map[string]map[string]bool{
			"app":   {"medium": true, "high": true, "critical": true},
			"email": {"medium": false, "high": true, "critical": true, "recovered": true, "false_alarm": true, "resolved": true},
			"sms":   {"medium": false, "high": false, "critical": true, "recovered": true, "false_alarm": false, "resolved": false},
		},
		EmailRecipients: []Recipient{},
		SMSRecipients:   []Recipient{},
		FollowUps:       map[string]bool{"recovered": true, "false_alarm": true, "resolved": true},
		Templates:       DefaultTemplates(),
	}
}

// DefaultTemplates are the built-in messages.
func DefaultTemplates() map[string]Template {
	return map[string]Template{
		"alert": {
			Subject: "[{{severity_upper}}] Fall detected: {{camera}}",
			Body: `A fall was detected by FallGuard.

Severity: {{severity_upper}}
Camera:   {{camera}}
Location: {{location}}
Zone:     {{zone}}
Time:     {{time}}
Status:   {{status}}

{{summary}}

Open the incident: {{link}}

— FallGuard, {{org}}`,
			SMS: "FallGuard {{severity_upper}}: fall on {{camera}} ({{location}}) at {{time_short}}. {{link}}",
		},
		"recovered": {
			Subject: "Update: person recovered ({{camera}})",
			Body: `The person in the fall detected on {{camera}} at {{time}} is back on their feet.

Down for: {{duration}}
Location: {{location}}

Open the incident: {{link}}

— FallGuard, {{org}}`,
			SMS: "FallGuard update: person recovered on {{camera}} (down {{duration}}).",
		},
		"false_alarm": {
			Subject: "Update: false alarm ({{camera}})",
			Body: `The fall alert on {{camera}} at {{time}} was marked as a false alarm by {{actor}}.

Open the incident: {{link}}

— FallGuard, {{org}}`,
			SMS: "FallGuard update: alert on {{camera}} at {{time_short}} was a false alarm ({{actor}}).",
		},
		"resolved": {
			Subject: "Update: alert resolved ({{camera}})",
			Body: `The fall alert on {{camera}} at {{time}} was resolved by {{actor}}.

Open the incident: {{link}}

— FallGuard, {{org}}`,
			SMS: "FallGuard update: alert on {{camera}} at {{time_short}} resolved by {{actor}}.",
		},
	}
}

// Placeholders lists what templates can use, with a description.
var Placeholders = map[string]string{
	"org": "Organization name", "severity": "medium / high / critical", "severity_upper": "MEDIUM / HIGH / CRITICAL",
	"camera": "Camera name", "location": "Camera location", "zone": "Zone", "time": "When the fall was detected",
	"time_short": "Time only (HH:MM)", "status": "Alert status", "summary": "What the detector saw",
	"duration": "How long the person was down", "actor": "Who acted on the alert", "link": "Link to the incident",
	"incident_id": "Incident ID",
}

var placeholder = regexp.MustCompile(`\{\{\s*([a-z_]+)\s*\}\}`)

// Render fills in {{name}} placeholders; unknown ones are left as they are.
func Render(tpl string, values map[string]string) string {
	return placeholder.ReplaceAllStringFunc(tpl, func(m string) string {
		key := placeholder.FindStringSubmatch(m)[1]
		if v, ok := values[key]; ok {
			return v
		}
		return m
	})
}

// Message returns the subject, email body and SMS text for an event, using the
// organization's custom template if it has one.
func (c Config) Message(event string, values map[string]string) (subject, body, sms string) {
	t := DefaultTemplates()[event]
	if ct, ok := c.Templates[event]; ok && ct.Custom {
		if strings.TrimSpace(ct.Subject) != "" {
			t.Subject = ct.Subject
		}
		if strings.TrimSpace(ct.Body) != "" {
			t.Body = ct.Body
		}
		if strings.TrimSpace(ct.SMS) != "" {
			t.SMS = ct.SMS
		}
	}
	subject = strings.Join(strings.Fields(Render(t.Subject, values)), " ")
	sms = Render(t.SMS, values)
	if utf8.RuneCountInString(sms) > 480 {
		sms = string([]rune(sms)[:477]) + "..."
	}
	return subject, Render(t.Body, values), sms
}

// Normalize fills in missing parts with defaults (settings saved by an older version).
func (c Config) Normalize() Config {
	d := DefaultConfig()
	if c.Matrix == nil {
		c.Matrix = d.Matrix
	}
	for _, ch := range Channels {
		if c.Matrix[ch] == nil {
			c.Matrix[ch] = d.Matrix[ch]
		}
	}
	if c.EmailRecipients == nil {
		c.EmailRecipients = []Recipient{}
	}
	if c.SMSRecipients == nil {
		c.SMSRecipients = []Recipient{}
	}
	if c.FollowUps == nil {
		c.FollowUps = d.FollowUps
	}
	c.migrateUpdates()
	c.FollowUps = map[string]bool{}
	for _, ev := range FollowUps {
		c.FollowUps[ev] = c.Matrix["email"][ev] || c.Matrix["sms"][ev]
	}
	if c.Templates == nil {
		c.Templates = map[string]Template{}
	}
	for _, e := range Events {
		if _, ok := c.Templates[e]; !ok {
			c.Templates[e] = d.Templates[e]
		}
	}
	return c
}

// Validate checks settings sent by the app and cleans them.
func (c *Config) Validate() error {
	*c = c.Normalize()
	for ch := range c.Matrix {
		if !slices.Contains(Channels, ch) {
			return fmt.Errorf("unknown channel %q", ch)
		}
		for key := range c.Matrix[ch] {
			if !slices.Contains(Severities, key) && !(slices.Contains(FollowUps, key) && slices.Contains(updateChannels, ch)) {
				return fmt.Errorf("unknown severity or update %q for %s", key, ch)
			}
		}
	}
	check := func(list []Recipient, isEmail bool) error {
		if len(list) > 100 {
			return errors.New("at most 100 recipients per channel")
		}
		seen := map[string]bool{}
		for i := range list {
			r := &list[i]
			r.Name = strings.TrimSpace(r.Name)
			r.Address = strings.TrimSpace(r.Address)
			if isEmail {
				r.Address = strings.ToLower(r.Address)
				if a, err := mail.ParseAddress(r.Address); err != nil || a.Address != r.Address {
					return fmt.Errorf("%q is not a valid email address", r.Address)
				}
			} else {
				r.Address = strings.NewReplacer(" ", "", "-", "", "(", "", ")", "", ".", "").Replace(r.Address)
				if !E164.MatchString(r.Address) {
					return fmt.Errorf("%q is not a valid phone number: use international format, e.g. +14165550123", r.Address)
				}
			}
			if seen[r.Address] {
				return fmt.Errorf("%s is listed twice", r.Address)
			}
			seen[r.Address] = true
			if len(r.Name) > 100 {
				return errors.New("recipient names must be at most 100 characters")
			}
			clean := []string{}
			for _, s := range r.Severities {
				if !slices.Contains(Severities, s) && !slices.Contains(FollowUps, s) {
					return fmt.Errorf("unknown severity or update %q", s)
				}
				if !slices.Contains(clean, s) {
					clean = append(clean, s)
				}
			}
			r.Severities = clean
		}
		return nil
	}
	if err := check(c.EmailRecipients, true); err != nil {
		return err
	}
	if err := check(c.SMSRecipients, false); err != nil {
		return err
	}
	for k := range c.FollowUps {
		if !slices.Contains(FollowUps, k) {
			return fmt.Errorf("unknown follow-up %q", k)
		}
	}
	for k, t := range c.Templates {
		if !slices.Contains(Events, k) {
			return fmt.Errorf("unknown template %q", k)
		}
		if len(t.Subject) > 300 || len(t.Body) > 10000 || len(t.SMS) > 480 {
			return errors.New("template too long (subject 300, body 10000, SMS 480 characters)")
		}
	}
	c.AppURL = strings.TrimRight(strings.TrimSpace(c.AppURL), "/")
	if c.AppURL != "" && !strings.HasPrefix(c.AppURL, "http://") && !strings.HasPrefix(c.AppURL, "https://") {
		return errors.New("app address must start with http:// or https://")
	}
	return nil
}

// migrateUpdates: settings saved before updates were matrix rows and recipient choices
// keep working as they did: each update on for email and SMS when its switch was on, and
// ticked for every recipient (they used to go to whoever got the alert).
func (c *Config) migrateUpdates() {
	for _, ch := range updateChannels {
		for _, ev := range FollowUps {
			if _, ok := c.Matrix[ch][ev]; ok {
				return // already in the new form
			}
		}
	}
	for _, ch := range updateChannels {
		m := map[string]bool{}
		for k, v := range c.Matrix[ch] {
			m[k] = v
		}
		for _, ev := range FollowUps {
			m[ev] = c.FollowUps[ev]
		}
		c.Matrix[ch] = m
	}
	tick := func(list []Recipient) []Recipient {
		out := make([]Recipient, len(list))
		for i, r := range list {
			r.Severities = slices.Clone(r.Severities)
			for _, ev := range FollowUps {
				if c.FollowUps[ev] && !slices.Contains(r.Severities, ev) {
					r.Severities = append(r.Severities, ev)
				}
			}
			out[i] = r
		}
		return out
	}
	c.EmailRecipients = tick(c.EmailRecipients)
	c.SMSRecipients = tick(c.SMSRecipients)
}

// Wants reports whether a recipient gets messages at a severity, or for an update.
func (r Recipient) Wants(severity string) bool {
	return r.Enabled && slices.Contains(r.Severities, severity)
}

// SeverityRank orders severities (low and unknown = 0).
func SeverityRank(s string) int { return slices.Index(Severities, s) + 1 }
