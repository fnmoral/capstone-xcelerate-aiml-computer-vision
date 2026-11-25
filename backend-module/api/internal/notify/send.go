// Package notify sends email and SMS (SMTP, Twilio, or the log when no provider is set
// up) and fills in message templates. Provider passwords are stored encrypted (Box).
package notify

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"mime/quotedprintable"
	"net"
	"net/http"
	"net/mail"
	"net/smtp"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// ---------- secrets ----------

// Box encrypts provider secrets (SMTP password, Twilio auth token) with AES-GCM.
type Box struct{ aead cipher.AEAD }

// NewBox makes a Box from any secret string (hashed to a 256-bit key).
func NewBox(secret string) (*Box, error) {
	key := sha256.Sum256([]byte(secret))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Box{aead}, nil
}

// Seal encrypts a value ("" stays "").
func (b *Box) Seal(plain string) (string, error) {
	if plain == "" {
		return "", nil
	}
	nonce := make([]byte, b.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	return "v1:" + base64.StdEncoding.EncodeToString(b.aead.Seal(nonce, nonce, []byte(plain), nil)), nil
}

// Open decrypts a value made by Seal.
func (b *Box) Open(sealed string) (string, error) {
	if sealed == "" {
		return "", nil
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(sealed, "v1:"))
	if err != nil || len(raw) < b.aead.NonceSize() {
		return "", errors.New("stored secret is unreadable; enter it again")
	}
	plain, err := b.aead.Open(nil, raw[:b.aead.NonceSize()], raw[b.aead.NonceSize():], nil)
	if err != nil {
		return "", errors.New("stored secret can't be decrypted (APP_SECRET changed?); enter it again")
	}
	return string(plain), nil
}

// ---------- providers ----------

// EmailProvider is how an organization sends email. Type "log" (default) writes messages
// to the API log instead of sending them.
type EmailProvider struct {
	Type        string `json:"type"` // log | smtp
	Host        string `json:"host"`
	Port        int    `json:"port"`
	Security    string `json:"security"` // starttls | tls | none
	Username    string `json:"username"`
	PasswordEnc string `json:"password_enc,omitempty"`
	FromEmail   string `json:"from_email"`
	FromName    string `json:"from_name"`
	password    string
}

// SMSProvider is how an organization sends SMS. Type "log" (default) writes them to the log.
type SMSProvider struct {
	Type         string `json:"type"` // log | twilio
	AccountSID   string `json:"account_sid"`
	AuthTokenEnc string `json:"auth_token_enc,omitempty"`
	FromNumber   string `json:"from_number"`
	authToken    string
}

// Unlock decrypts the provider's password.
func (p *EmailProvider) Unlock(b *Box) error {
	var err error
	p.password, err = b.Open(p.PasswordEnc)
	return err
}

// Unlock decrypts the provider's auth token.
func (p *SMSProvider) Unlock(b *Box) error {
	var err error
	p.authToken, err = b.Open(p.AuthTokenEnc)
	return err
}

// Email is one message to one address.
type Email struct {
	To, Subject, Text string
	HTML              string // optional: sent as an HTML alternative to Text
	// Preview is the HTML with personal links taken out, kept for Settings > Emails sent.
	// Never sent.
	Preview string
}

// Result says what happened to a message: "sent" or "logged" (no provider).
type Result string

// Sending results.
const (
	Sent   Result = "sent"
	Logged Result = "logged"
)

var headerUnsafe = regexp.MustCompile(`[\r\n]`)

// SendEmail sends one email with the provider (or logs it).
func SendEmail(ctx context.Context, p EmailProvider, m Email) (Result, error) {
	if _, err := mail.ParseAddress(m.To); err != nil {
		return "", fmt.Errorf("invalid recipient %q", m.To)
	}
	if p.Type != "smtp" {
		log.Printf("[email:log] to=%s subject=%q\n%s", m.To, m.Subject, m.Text)
		return Logged, nil
	}
	if p.Host == "" || p.FromEmail == "" {
		return "", errors.New("SMTP host and from address are required")
	}
	port := p.Port
	if port == 0 {
		port = map[string]int{"tls": 465, "none": 25}[p.Security]
		if port == 0 {
			port = 587
		}
	}
	if err := smtpSend(ctx, p, port, m.To, buildMessage(p, m)); err != nil {
		return "", err
	}
	return Sent, nil
}

// buildMessage makes the email: plain text, or plain text + HTML (multipart/alternative),
// with the headers mail services expect from a real sender (Date, Message-ID).
func buildMessage(p EmailProvider, m Email) []byte {
	from := mail.Address{Name: p.FromName, Address: p.FromEmail}
	domain := "localhost"
	if at := strings.LastIndex(p.FromEmail, "@"); at >= 0 {
		domain = p.FromEmail[at+1:]
	}
	id := make([]byte, 12)
	_, _ = rand.Read(id)
	head := []string{
		"From: " + from.String(),
		"To: " + m.To,
		"Subject: " + mime.QEncoding.Encode("utf-8", headerUnsafe.ReplaceAllString(m.Subject, " ")),
		"Date: " + time.Now().Format(time.RFC1123Z),
		fmt.Sprintf("Message-ID: <%x.%d@%s>", id, time.Now().UnixNano(), domain),
		"MIME-Version: 1.0",
	}
	if m.HTML == "" {
		head = append(head, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: quoted-printable", "", qp(m.Text))
		return []byte(strings.Join(head, "\r\n"))
	}
	boundary := fmt.Sprintf("fg-%x", id)
	head = append(head, `Content-Type: multipart/alternative; boundary="`+boundary+`"`, "",
		"--"+boundary,
		"Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: quoted-printable", "", qp(m.Text),
		"--"+boundary,
		"Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: quoted-printable", "", qp(m.HTML),
		"--"+boundary+"--", "")
	return []byte(strings.Join(head, "\r\n"))
}

// qp encodes a body as quoted-printable with CRLF line ends (safe for any SMTP server).
func qp(s string) string {
	var b strings.Builder
	w := quotedprintable.NewWriter(&b)
	_, _ = w.Write([]byte(strings.ReplaceAll(strings.ReplaceAll(s, "\r\n", "\n"), "\n", "\r\n")))
	_ = w.Close()
	return b.String()
}

func smtpSend(ctx context.Context, p EmailProvider, port int, to string, msg []byte) error {
	addr := net.JoinHostPort(p.Host, strconv.Itoa(port))
	d := net.Dialer{Timeout: 10 * time.Second}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	var conn net.Conn
	var err error
	if p.Security == "tls" {
		conn, err = (&tls.Dialer{NetDialer: &d, Config: &tls.Config{ServerName: p.Host, MinVersion: tls.VersionTLS12}}).DialContext(ctx, "tcp", addr)
	} else {
		conn, err = d.DialContext(ctx, "tcp", addr)
	}
	if err != nil {
		return fmt.Errorf("can't connect to %s: %w", addr, err)
	}
	if dl, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(dl)
	}
	c, err := smtp.NewClient(conn, p.Host)
	if err != nil {
		conn.Close()
		return fmt.Errorf("SMTP greeting: %w", err)
	}
	defer c.Close()
	if p.Security == "starttls" || p.Security == "" {
		if ok, _ := c.Extension("STARTTLS"); !ok {
			return errors.New("server doesn't offer STARTTLS; choose TLS or None")
		}
		if err := c.StartTLS(&tls.Config{ServerName: p.Host, MinVersion: tls.VersionTLS12}); err != nil {
			return fmt.Errorf("STARTTLS: %w", err)
		}
	}
	if p.Username != "" {
		if ok, _ := c.Extension("AUTH"); !ok {
			return errors.New("server doesn't accept a login; clear the username")
		}
		// smtp.PlainAuth refuses to send the password over an unencrypted link (except localhost).
		if err := c.Auth(smtp.PlainAuth("", p.Username, p.password, p.Host)); err != nil {
			return fmt.Errorf("login failed: %w", err)
		}
	}
	if err := c.Mail(p.FromEmail); err != nil {
		return fmt.Errorf("MAIL FROM: %w", err)
	}
	if err := c.Rcpt(to); err != nil {
		return fmt.Errorf("RCPT TO: %w", err)
	}
	w, err := c.Data()
	if err != nil {
		return err
	}
	if _, err := w.Write(msg); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return err
	}
	return c.Quit()
}

// E164 matches an international phone number such as +14165550123.
var E164 = regexp.MustCompile(`^\+[1-9][0-9]{7,14}$`)

// twilioBase is Twilio's API address (a variable so tests can point it elsewhere).
var twilioBase = "https://api.twilio.com"

// SendSMS sends one text message with the provider (or logs it).
func SendSMS(ctx context.Context, p SMSProvider, to, text string) (Result, error) {
	res, _, err := SendSMSInfo(ctx, p, to, text)
	return res, err
}

// TrialTemplate is the Twilio trial template sent instead of FallGuard's own text when the
// Twilio account is a trial: trials may send only Twilio's predefined messages, chosen by
// putting the template's name in the body (error 572006 "Invalid template name" otherwise).
const TrialTemplate = "sms_event_notifications"

// twilioTrialOnly is Twilio's error code for a custom body sent from a trial account.
const twilioTrialOnly = 572006

// SendSMSInfo is SendSMS that also says whether Twilio's trial template went out instead of
// the text (a trial Twilio account: see TrialTemplate). Upgraded accounts send the text.
func SendSMSInfo(ctx context.Context, p SMSProvider, to, text string) (Result, bool, error) {
	if !E164.MatchString(to) {
		return "", false, fmt.Errorf("invalid phone number %q (use +1… format)", to)
	}
	if p.Type != "twilio" {
		log.Printf("[sms:log] to=%s %s", to, text)
		return Logged, false, nil
	}
	if p.AccountSID == "" || p.authToken == "" || p.FromNumber == "" {
		return "", false, errors.New("Twilio account SID, auth token and from number are required")
	}
	code, err := postTwilio(ctx, p, to, text)
	if err != nil && code == twilioTrialOnly && text != TrialTemplate {
		log.Printf("[sms] Twilio trial account: sending its %s template to %s instead of the text", TrialTemplate, to)
		if _, err2 := postTwilio(ctx, p, to, TrialTemplate); err2 != nil {
			return "", false, err2
		}
		return Sent, true, nil
	}
	if err != nil {
		return "", false, err
	}
	return Sent, false, nil
}

// postTwilio sends one message; on failure it returns Twilio's error code (0 if none).
func postTwilio(ctx context.Context, p SMSProvider, to, text string) (int, error) {
	form := url.Values{"To": {to}, "From": {p.FromNumber}, "Body": {text}}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		twilioBase+"/2010-04-01/Accounts/"+url.PathEscape(p.AccountSID)+"/Messages.json", strings.NewReader(form.Encode()))
	if err != nil {
		return 0, err
	}
	req.SetBasicAuth(p.AccountSID, p.authToken)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, fmt.Errorf("can't reach Twilio: %w", err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
	if res.StatusCode >= 300 {
		var e struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		}
		_ = json.Unmarshal(body, &e)
		if e.Message == "" {
			e.Message = res.Status
		}
		return e.Code, fmt.Errorf("Twilio: %s", e.Message)
	}
	return 0, nil
}

// SetPassword sets the password directly (server SMTP settings from the environment).
func (p *EmailProvider) SetPassword(pw string) { p.password = pw }
