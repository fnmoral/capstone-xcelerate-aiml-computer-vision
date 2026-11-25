package api

import (
	"bytes"
	"html"
	"html/template"
	"regexp"
	"strings"

	"github.com/gin-gonic/gin"

	"backend-api/internal/notify"
)

// accountMail is the content of an account email (invitation, email check, password reset).
// It is sent as plain text and as a simple branded HTML page: logo, one button, a footer.
// Mail services trust a message with both versions more than a bare link in plain text.
type accountMail struct {
	Greeting string
	Lines    []string
	Button   string
	Link     string
	Note     string
}

var accountMailHTML = template.Must(template.New("mail").Parse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light"><title>{{.Subject}}</title></head>
<body style="margin:0;padding:0;background:#f1f3f5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f3f5;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;border:1px solid #dee2e6;">
<tr><td style="padding:28px 32px 8px 32px;">
<img src="{{.AppURL}}/brand/email-logo.png" width="183" height="48" alt="FallGuard Vision" style="display:block;border:0;">
</td></tr>
<tr><td style="padding:16px 32px 8px 32px;font-family:Segoe UI,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.55;color:#16191d;">
<p style="margin:0 0 12px 0;">{{.Greeting}}</p>
{{range .Lines}}<p style="margin:0 0 12px 0;">{{.}}</p>{{end}}
</td></tr>
<tr><td style="padding:8px 32px 8px 32px;">
<a href="{{.Link}}" style="display:inline-block;background:#1971c2;color:#ffffff;text-decoration:none;font-family:Segoe UI,Helvetica,Arial,sans-serif;font-size:16px;font-weight:600;padding:12px 22px;border-radius:8px;">{{.Button}}</a>
</td></tr>
<tr><td style="padding:16px 32px 24px 32px;font-family:Segoe UI,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.5;color:#495057;">
<p style="margin:0 0 10px 0;">{{.Note}}</p>
<p style="margin:0;">Button not working? Copy this link into your browser:<br><a href="{{.Link}}" style="color:#1971c2;word-break:break-all;">{{.LinkText}}</a></p>
</td></tr>
<tr><td style="padding:16px 32px 24px 32px;border-top:1px solid #e9ecef;font-family:Segoe UI,Helvetica,Arial,sans-serif;font-size:12px;line-height:1.5;color:#868e96;">
FallGuard Vision · fall detection for care homes, clinics and workplaces<br>
Powered by Xcelerate Industries · <a href="{{.AppURL}}" style="color:#868e96;">{{.Host}}</a><br>
You received this because someone used this address on FallGuard Vision.
</td></tr>
</table>
</td></tr></table>
</body></html>`))

// accountEmail builds the plain-text and HTML versions of an account email.
func (s *Server) accountEmail(c *gin.Context, to, subject string, m accountMail) notify.Email {
	app := s.appURL(c)
	var text strings.Builder
	text.WriteString(m.Greeting + "\n\n")
	for _, l := range m.Lines {
		text.WriteString(l + "\n\n")
	}
	text.WriteString(m.Button + ":\n" + m.Link + "\n\n" + m.Note + "\n\n— FallGuard Vision\n" + app + "\n")

	host := strings.TrimPrefix(strings.TrimPrefix(app, "https://"), "http://")
	render := func(link, linkText string) string {
		var out bytes.Buffer
		_ = accountMailHTML.Execute(&out, map[string]any{
			"Subject": subject, "AppURL": app, "Host": host, "Greeting": m.Greeting, "Lines": m.Lines,
			"Button": m.Button, "Link": template.URL(link), "LinkText": linkText, "Note": m.Note,
		})
		return out.String()
	}
	return notify.Email{
		To: to, Subject: subject, Text: text.String(), HTML: render(m.Link, m.Link),
		// The copy kept for Emails sent: the personal link opens the account, so it is not kept.
		Preview: render("#", "(their personal link: not kept, for security)"),
	}
}

var urlInText = regexp.MustCompile(`https?://[^\s<>"]+`)

var alertMailHTML = template.Must(template.New("alert").Parse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light"><title>{{.Subject}}</title></head>
<body style="margin:0;padding:0;background:#f1f3f5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f3f5;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;border:1px solid #dee2e6;">
{{if .Logo}}<tr><td style="padding:28px 32px 8px 32px;">
<img src="{{.Logo}}" width="183" height="48" alt="FallGuard Vision" style="display:block;border:0;">
</td></tr>{{end}}
{{if .Banner}}<tr><td style="padding:12px 32px 0 32px;">
<div style="background:#fff4e6;border:1px solid #ffd8a8;border-radius:8px;padding:12px 14px;font-family:Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#7a3e00;">{{range .Banner}}<p style="margin:0 0 4px 0;">{{.}}</p>{{end}}</div>
</td></tr>{{end}}
<tr><td style="padding:16px 32px 8px 32px;font-family:Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#16191d;">
<div style="white-space:pre-wrap;">{{.Body}}</div>
</td></tr>
{{if .Link}}<tr><td style="padding:8px 32px 24px 32px;">
<a href="{{.Link}}" style="display:inline-block;background:#1971c2;color:#ffffff;text-decoration:none;font-family:Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;padding:11px 20px;border-radius:8px;">Open in FallGuard</a>
</td></tr>{{end}}
<tr><td style="padding:16px 32px 24px 32px;border-top:1px solid #e9ecef;font-family:Segoe UI,Helvetica,Arial,sans-serif;font-size:12px;line-height:1.5;color:#868e96;">
FallGuard Vision · fall detection for care homes, clinics and workplaces<br>
Powered by Xcelerate Industries · You get this because you're on your organization's alert list.
</td></tr>
</table>
</td></tr></table>
</body></html>`))

// alertEmail wraps a notification (its subject and plain-text body from the templates) in the
// branded HTML layout: logo, an optional banner (e.g. "this is a test"), the body with its links
// clickable, and a button to the first link. appURL must be public for the logo to show.
func alertEmail(appURL, to, subject, body string, banner []string, button bool) notify.Email {
	var b strings.Builder
	esc := template.HTMLEscapeString(body)
	last, link := 0, ""
	for _, m := range urlInText.FindAllStringIndex(esc, -1) {
		u := esc[m[0]:m[1]]
		if link == "" {
			link = html.UnescapeString(u)
		}
		b.WriteString(esc[last:m[0]])
		b.WriteString(`<a href="` + u + `" style="color:#1971c2;word-break:break-all;">` + u + `</a>`)
		last = m[1]
	}
	b.WriteString(esc[last:])
	logo := ""
	if strings.HasPrefix(appURL, "https://") {
		logo = appURL + "/brand/email-logo.png"
	}
	if !button {
		link = ""
	}
	var out bytes.Buffer
	_ = alertMailHTML.Execute(&out, map[string]any{
		"Subject": subject, "Logo": logo, "Banner": banner, "Body": template.HTML(b.String()), "Link": template.URL(link),
	})
	text := body
	if len(banner) > 0 {
		text = strings.Join(banner, "\n") + "\n\n" + body
	}
	return notify.Email{To: to, Subject: subject, Text: text, HTML: out.String()}
}
