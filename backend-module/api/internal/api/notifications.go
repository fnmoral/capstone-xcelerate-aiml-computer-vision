package api

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"net/mail"
	"slices"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"backend-api/internal/notify"
	"backend-api/internal/store"
)

// ---------- settings routes ----------

// publicEmail / publicSMS hide stored secrets: the app only learns whether one is set.
func publicEmail(p notify.EmailProvider) gin.H {
	return gin.H{"type": p.Type, "host": p.Host, "port": p.Port, "security": p.Security, "username": p.Username,
		"from_email": p.FromEmail, "from_name": p.FromName, "password_set": p.PasswordEnc != ""}
}

func publicSMS(p notify.SMSProvider) gin.H {
	return gin.H{"type": p.Type, "account_sid": p.AccountSID, "from_number": p.FromNumber, "auth_token_set": p.AuthTokenEnc != ""}
}

func (s *Server) notificationSettings(c *gin.Context) {
	ctx := c.Request.Context()
	ns, err := s.db.Notifications(ctx)
	if err != nil {
		fail(c, err)
		return
	}
	members, err := s.db.Members(ctx)
	if err != nil {
		fail(c, err)
		return
	}
	people := []gin.H{}
	for _, m := range members {
		people = append(people, gin.H{"user_id": m.ID, "name": m.DisplayName(), "email": m.Email, "phone": m.Phone, "role": m.Role})
	}
	c.JSON(http.StatusOK, gin.H{
		"config":            ns.Config,
		"email_provider":    publicEmail(ns.Email),
		"sms_provider":      publicSMS(ns.SMS),
		"default_templates": notify.DefaultTemplates(),
		"placeholders":      notify.Placeholders,
		"members":           people,
		"system_smtp":       s.cfg.SMTP.Type == "smtp", // account emails use the server's SMTP settings
		"server_from":       s.serverFrom(),            // FallGuard's own sender ("" = none)
	})
}

// serverFrom is the sender of FallGuard's own email (SMTP_* in the environment), or "".
func (s *Server) serverFrom() string {
	if s.cfg.SMTP.Type != "smtp" {
		return ""
	}
	return s.cfg.SMTP.FromEmail
}

// sendingEmail turns an organization's saved email provider into the one to send with:
// "server" = FallGuard's own email server (SMTP_*), "smtp" = theirs (password decrypted).
func (s *Server) sendingEmail(p notify.EmailProvider) (notify.EmailProvider, error) {
	if p.Type == "server" {
		if s.cfg.SMTP.Type != "smtp" {
			return p, fmt.Errorf("FallGuard's email isn't set up on this server; choose your own email server")
		}
		return s.cfg.SMTP, nil
	}
	return p, p.Unlock(s.box)
}

func (s *Server) saveNotificationSettings(c *gin.Context) {
	var in notify.Config
	if err := c.ShouldBindJSON(&in); err != nil {
		badRequest(c, "invalid JSON")
		return
	}
	if err := in.Validate(); err != nil {
		badRequest(c, err.Error())
		return
	}
	if err := s.db.SaveNotificationConfig(c.Request.Context(), in, actor(c)); err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"config": in})
}

type emailProviderInput struct {
	Type      string `json:"type"`
	Host      string `json:"host"`
	Port      int    `json:"port"`
	Security  string `json:"security"`
	Username  string `json:"username"`
	Password  string `json:"password"` // empty = keep the saved one
	FromEmail string `json:"from_email"`
	FromName  string `json:"from_name"`
}

// emailProvider checks the input and merges it with the saved provider (kept password).
func (s *Server) emailProvider(in emailProviderInput, saved notify.EmailProvider) (notify.EmailProvider, error) {
	p := notify.EmailProvider{Type: in.Type, Host: strings.TrimSpace(in.Host), Port: in.Port, Security: in.Security,
		Username: strings.TrimSpace(in.Username), FromEmail: strings.TrimSpace(in.FromEmail), FromName: strings.TrimSpace(in.FromName)}
	switch p.Type {
	case "log":
		return notify.EmailProvider{Type: "log"}, nil
	case "server":
		if s.cfg.SMTP.Type != "smtp" {
			return p, fmt.Errorf("FallGuard's email isn't set up on this server; choose your own email server")
		}
		return notify.EmailProvider{Type: "server"}, nil
	case "smtp":
	default:
		return p, fmt.Errorf("type must be log, server or smtp")
	}
	if p.Host == "" || strings.ContainsAny(p.Host, " /\\") {
		return p, fmt.Errorf("enter the SMTP server host, e.g. smtp.office365.com")
	}
	if p.Port < 0 || p.Port > 65535 {
		return p, fmt.Errorf("port must be between 1 and 65535")
	}
	if p.Security == "" {
		p.Security = "starttls"
	}
	if p.Security != "starttls" && p.Security != "tls" && p.Security != "none" {
		return p, fmt.Errorf("security must be starttls, tls or none")
	}
	if a, err := mail.ParseAddress(p.FromEmail); err != nil || a.Address != p.FromEmail {
		return p, fmt.Errorf("enter a valid sender address (from email)")
	}
	if in.Password != "" {
		enc, err := s.box.Seal(in.Password)
		if err != nil {
			return p, err
		}
		p.PasswordEnc = enc
	} else if saved.Type == "smtp" && saved.Username == p.Username && saved.Host == p.Host {
		p.PasswordEnc = saved.PasswordEnc
	}
	return p, nil
}

func (s *Server) saveEmailProvider(c *gin.Context) {
	var in emailProviderInput
	if err := c.ShouldBindJSON(&in); err != nil {
		badRequest(c, "invalid JSON")
		return
	}
	ns, err := s.db.Notifications(c.Request.Context())
	if err != nil {
		fail(c, err)
		return
	}
	p, err := s.emailProvider(in, ns.Email)
	if err != nil {
		badRequest(c, err.Error())
		return
	}
	if err := s.db.SaveEmailProvider(c.Request.Context(), p, actor(c)); err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"email_provider": publicEmail(p)})
}

type smsProviderInput struct {
	Type       string `json:"type"`
	AccountSID string `json:"account_sid"`
	AuthToken  string `json:"auth_token"` // empty = keep the saved one
	FromNumber string `json:"from_number"`
}

func (s *Server) smsProvider(in smsProviderInput, saved notify.SMSProvider) (notify.SMSProvider, error) {
	p := notify.SMSProvider{Type: in.Type, AccountSID: strings.TrimSpace(in.AccountSID), FromNumber: strings.TrimSpace(in.FromNumber)}
	switch p.Type {
	case "log":
		return notify.SMSProvider{Type: "log"}, nil
	case "twilio":
	default:
		return p, fmt.Errorf("type must be log or twilio")
	}
	if !strings.HasPrefix(p.AccountSID, "AC") || len(p.AccountSID) != 34 {
		return p, fmt.Errorf("the Twilio account SID starts with AC and is 34 characters long")
	}
	if !notify.E164.MatchString(p.FromNumber) && !strings.HasPrefix(p.FromNumber, "MG") {
		return p, fmt.Errorf("from number must be a Twilio number in +1… format (or a Messaging Service SID, MG…)")
	}
	if in.AuthToken != "" {
		enc, err := s.box.Seal(in.AuthToken)
		if err != nil {
			return p, err
		}
		p.AuthTokenEnc = enc
	} else if saved.Type == "twilio" && saved.AccountSID == p.AccountSID {
		p.AuthTokenEnc = saved.AuthTokenEnc
	}
	if p.AuthTokenEnc == "" {
		return p, fmt.Errorf("enter the Twilio auth token")
	}
	return p, nil
}

func (s *Server) saveSMSProvider(c *gin.Context) {
	var in smsProviderInput
	if err := c.ShouldBindJSON(&in); err != nil {
		badRequest(c, "invalid JSON")
		return
	}
	ns, err := s.db.Notifications(c.Request.Context())
	if err != nil {
		fail(c, err)
		return
	}
	p, err := s.smsProvider(in, ns.SMS)
	if err != nil {
		badRequest(c, err.Error())
		return
	}
	if err := s.db.SaveSMSProvider(c.Request.Context(), p, actor(c)); err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"sms_provider": publicSMS(p)})
}

// sampleValues fills templates for previews and tests.
func (s *Server) sampleValues(c *gin.Context) map[string]string {
	se := session(c)
	now := time.Now()
	return map[string]string{
		"org": se.OrgName, "severity": "high", "severity_upper": "HIGH", "camera": "CAM-01 Hallway",
		"location": "2nd floor hallway", "zone": "East wing", "time": now.Format("Mon Jan 2 2006, 15:04 MST"),
		"time_short": now.Format("15:04"), "status": "open", "summary": "Person lying on the floor (confidence 0.91)",
		"duration": "1 min 20 s", "actor": se.User.DisplayName(), "link": s.appURL(c) + "/events/sample", "incident_id": "sample",
	}
}

func (s *Server) testEmail(c *gin.Context) {
	var in struct {
		To       string              `json:"to"`
		Provider *emailProviderInput `json:"provider"` // test unsaved settings; omitted = the saved ones
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		badRequest(c, "invalid JSON")
		return
	}
	ctx := c.Request.Context()
	ns, err := s.db.Notifications(ctx)
	if err != nil {
		fail(c, err)
		return
	}
	p := ns.Email
	if in.Provider != nil {
		if p, err = s.emailProvider(*in.Provider, ns.Email); err != nil {
			badRequest(c, err.Error())
			return
		}
	}
	if p, err = s.sendingEmail(p); err != nil {
		badRequest(c, err.Error())
		return
	}
	to := strings.TrimSpace(in.To)
	if to == "" {
		to = session(c).User.Email
	}
	// The test shows what a real fall alert looks like: the organization's own alert
	// template filled with sample values, under a banner saying it's only a test.
	values := s.sampleValues(c)
	values["link"] = s.appURL(c) + "/events"
	sampleSubject, sampleBody, _ := ns.Config.Message("alert", values)
	subject := "[TEST] " + sampleSubject
	banner := []string{
		fmt.Sprintf("This is a test email from FallGuard Vision for %s, sent by %s.", session(c).OrgName, actor(c)),
		"No action needed: nobody fell. Below is what a fall alert looks like, with a sample camera, location and time.",
	}
	m := alertEmail(s.appURL(c), to, subject, sampleBody, banner, true)
	res, sendErr := notify.SendEmail(ctx, p, m)
	s.logTest(c, "email", to, subject, m.Text, res, sendErr)
}

func (s *Server) testSMS(c *gin.Context) {
	var in struct {
		To       string            `json:"to"`
		Provider *smsProviderInput `json:"provider"`
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		badRequest(c, "invalid JSON")
		return
	}
	ctx := c.Request.Context()
	ns, err := s.db.Notifications(ctx)
	if err != nil {
		fail(c, err)
		return
	}
	p := ns.SMS
	if in.Provider != nil {
		if p, err = s.smsProvider(*in.Provider, ns.SMS); err != nil {
			badRequest(c, err.Error())
			return
		}
	}
	if err := p.Unlock(s.box); err != nil {
		badRequest(c, err.Error())
		return
	}
	to := strings.NewReplacer(" ", "", "-", "", "(", "", ")", "").Replace(in.To)
	if to == "" && session(c).User.Phone != nil {
		to = *session(c).User.Phone
	}
	body := "FallGuard test SMS for " + session(c).OrgName + ". SMS notifications work."
	res, sendErr := notify.SendSMS(ctx, p, to, body)
	s.logTest(c, "sms", to, "", body, res, sendErr)
}

func (s *Server) logTest(c *gin.Context, channel, to, subject, body string, res notify.Result, sendErr error) {
	status, msg := string(res), ""
	var errText *string
	if sendErr != nil {
		status, msg = "failed", sendErr.Error()
		errText = &msg
	}
	if err := s.db.LogTestDelivery(c.Request.Context(), channel, to, subject, body, status, errText); err != nil {
		log.Printf("log test %s: %v", channel, err)
	}
	if sendErr != nil {
		c.JSON(http.StatusBadGateway, gin.H{"ok": false, "error": msg})
		return
	}
	note := "Sent to " + to + "."
	if res == notify.Logged {
		note = "No provider is set up, so the message was written to the server log instead of being sent (to " + to + ")."
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "result": res, "message": note})
}

func (s *Server) previewTemplate(c *gin.Context) {
	var in struct {
		Event    string          `json:"event"`
		Template notify.Template `json:"template"`
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		badRequest(c, "invalid JSON")
		return
	}
	if !slices.Contains(notify.Events, in.Event) {
		badRequest(c, "event must be alert, recovered, false_alarm or resolved")
		return
	}
	in.Template.Custom = true
	cfg := notify.Config{Templates: map[string]notify.Template{in.Event: in.Template}}
	subject, body, sms := cfg.Message(in.Event, s.sampleValues(c))
	c.JSON(http.StatusOK, gin.H{"subject": subject, "body": body, "sms": sms})
}

func (s *Server) notificationDeliveries(c *gin.Context) {
	list, err := s.db.Deliveries(c.Request.Context(), 200)
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"deliveries": list})
}

// ---------- dispatcher ----------

// RunNotifier turns new alerts and their changes into email / SMS messages and sends them.
// It checks every few seconds; each event is handled once (notification_events), and
// failed messages are retried (notification_deliveries).
func (s *Server) RunNotifier(ctx context.Context) {
	t := time.NewTicker(5 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		if err := s.notifyScan(ctx); err != nil {
			log.Printf("notifier: %v", err)
		}
		if err := s.sendPending(ctx); err != nil {
			log.Printf("notifier send: %v", err)
		}
	}
}

func formatDuration(sec int) string {
	if sec < 60 {
		return fmt.Sprintf("%d s", sec)
	}
	if sec < 3600 {
		return fmt.Sprintf("%d min %d s", sec/60, sec%60)
	}
	return fmt.Sprintf("%d h %d min", sec/3600, (sec%3600)/60)
}

func orDefault(p *string, fallback string) string {
	if p == nil || strings.TrimSpace(*p) == "" {
		return fallback
	}
	return *p
}

// alertValues fills templates for an alert.
func (s *Server) alertValues(a store.AlertForNotify, cfg notify.Config, severity string) map[string]string {
	loc, err := time.LoadLocation(a.Timezone)
	if err != nil {
		loc = time.UTC
	}
	base := cfg.AppURL
	if base == "" {
		base = s.appURL(nil)
	}
	link := base + "/events"
	if a.IncidentID != nil {
		link = base + "/events/" + *a.IncidentID
	}
	duration := "unknown"
	if a.DurationSeconds != nil {
		duration = formatDuration(*a.DurationSeconds)
	}
	return map[string]string{
		"org": a.OrgName, "severity": severity, "severity_upper": strings.ToUpper(severity),
		"camera": orDefault(a.CameraName, "Unknown camera"), "location": orDefault(a.Location, "—"), "zone": orDefault(a.Zone, "—"),
		"time": a.TriggeredAt.In(loc).Format("Mon Jan 2 2006, 15:04 MST"), "time_short": a.TriggeredAt.In(loc).Format("15:04"),
		"status": strings.ReplaceAll(a.Status, "_", " "), "summary": orDefault(a.Summary, ""), "duration": duration,
		"actor": orDefault(a.ClosedBy, "an operator"), "link": link, "incident_id": orDefault(a.IncidentID, ""),
	}
}

func (s *Server) notifyScan(ctx context.Context) error {
	tenants, err := s.db.NotifyTenants(ctx)
	if err != nil {
		return err
	}
	for _, tid := range tenants {
		ns, err := s.db.NotificationsFor(ctx, tid)
		if err != nil {
			return err
		}
		alerts, err := s.db.AlertsToNotify(ctx, tid)
		if err != nil {
			return err
		}
		for _, a := range alerts {
			if err := s.notifyAlert(ctx, tid, ns.Config, a); err != nil {
				log.Printf("notifier: alert %s: %v", a.ID, err)
			}
		}
	}
	return nil
}

// notifyAlert queues the messages for one alert: one each time it reaches a new severity
// (medium, high, critical), to whoever gets that severity, then the follow-ups.
func (s *Server) notifyAlert(ctx context.Context, tid string, cfg notify.Config, a store.AlertForNotify) error {
	rank := notify.SeverityRank(a.Severity)
	notified := false
	for _, sev := range notify.Severities {
		if a.Done["alert:"+sev] {
			notified = true
		}
	}
	for i, sev := range notify.Severities {
		if i+1 > rank || a.Done["alert:"+sev] {
			continue
		}
		msgs := []store.Delivery{}
		// Only the severity the alert has now gets messages; levels it passed between two
		// checks (or before it was first seen) are marked done silently, so a jump from
		// medium to critical sends one message, not two.
		if i+1 == rank {
			subject, body, sms := cfg.Message("alert", s.alertValues(a, cfg, sev))
			if cfg.Matrix["email"][sev] {
				for _, r := range cfg.EmailRecipients {
					if r.Wants(sev) {
						msgs = append(msgs, store.Delivery{Event: "alert:" + sev, Channel: "email", Recipient: r.Address, Subject: &subject, Body: body})
					}
				}
			}
			if cfg.Matrix["sms"][sev] {
				for _, r := range cfg.SMSRecipients {
					if r.Wants(sev) {
						msgs = append(msgs, store.Delivery{Event: "alert:" + sev, Channel: "sms", Recipient: r.Address, Body: sms})
					}
				}
			}
		}
		if _, err := s.db.QueueEvent(ctx, tid, a.ID, "alert:"+sev, msgs); err != nil {
			return err
		}
		notified = true
	}
	if !notified {
		return nil
	}
	happened := map[string]bool{
		"recovered":   a.RecoveredAt != nil || (a.IncidentStatus != nil && *a.IncidentStatus == "recovered"),
		"false_alarm": a.Status == "false_positive",
		"resolved":    a.Status == "resolved",
	}
	for _, ev := range notify.FollowUps {
		if !happened[ev] || a.Done[ev] {
			continue
		}
		msgs := []store.Delivery{}
		if cfg.FollowUps[ev] {
			got, err := s.db.AlertRecipients(ctx, a.ID)
			if err != nil {
				return err
			}
			subject, body, sms := cfg.Message(ev, s.alertValues(a, cfg, a.Severity))
			for _, to := range got["email"] {
				msgs = append(msgs, store.Delivery{Event: ev, Channel: "email", Recipient: to, Subject: &subject, Body: body})
			}
			for _, to := range got["sms"] {
				msgs = append(msgs, store.Delivery{Event: ev, Channel: "sms", Recipient: to, Body: sms})
			}
		}
		if _, err := s.db.QueueEvent(ctx, tid, a.ID, ev, msgs); err != nil {
			return err
		}
	}
	return nil
}

// sendPending sends queued messages with each organization's provider.
func (s *Server) sendPending(ctx context.Context) error {
	list, err := s.db.PendingDeliveries(ctx, 50)
	if err != nil {
		return err
	}
	providers := map[string]*store.NotificationSettings{}
	for _, d := range list {
		ns, ok := providers[d.TenantID]
		if !ok {
			if ns, err = s.db.NotificationsFor(ctx, d.TenantID); err != nil {
				return err
			}
			providers[d.TenantID] = ns
		}
		var res notify.Result
		var sendErr error
		switch d.Channel {
		case "email":
			var p notify.EmailProvider
			if p, sendErr = s.sendingEmail(ns.Email); sendErr == nil {
				app := strings.TrimRight(ns.Config.AppURL, "/")
				if app == "" {
					app = s.appURL(nil)
				}
				res, sendErr = notify.SendEmail(ctx, p, alertEmail(app, d.Recipient, orDefault(d.Subject, "FallGuard"), d.Body, nil, true))
			}
		case "sms":
			p := ns.SMS
			if sendErr = p.Unlock(s.box); sendErr == nil {
				res, sendErr = notify.SendSMS(ctx, p, d.Recipient, d.Body)
			}
		}
		if sendErr != nil {
			log.Printf("notifier: %s to %s failed: %v", d.Channel, d.Recipient, sendErr)
		}
		if err := s.db.DeliveryDone(ctx, d.ID, string(res), sendErr); err != nil {
			return err
		}
	}
	return nil
}

// appAlertsFilter drops alerts whose severity is switched off for in-app notifications.
func (s *Server) appAlertsFilter(ctx context.Context, alerts []store.Alert) []store.Alert {
	ns, err := s.db.Notifications(ctx)
	if err != nil {
		return alerts
	}
	out := alerts[:0]
	for _, a := range alerts {
		if on, known := ns.Config.Matrix["app"][a.Severity]; !known || on {
			out = append(out, a)
		}
	}
	return out
}
