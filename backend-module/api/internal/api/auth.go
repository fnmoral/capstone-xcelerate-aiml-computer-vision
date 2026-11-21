package api

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"backend-api/internal/auth"
	"backend-api/internal/notify"
	"backend-api/internal/store"
)

// Session and link lifetimes.
const (
	sessionCookie = "fg_session"
	sessionTTL    = 7 * 24 * time.Hour // sliding: extended while used
	verifyTTL     = 48 * time.Hour
	resetTTL      = time.Hour
	inviteTTL     = 7 * 24 * time.Hour
)

// ---------- middleware ----------

// requireAuth lets the request through only with a valid session cookie. The session's
// organization becomes the tenant of every query, and its user the actor in the audit log.
func (s *Server) requireAuth(c *gin.Context) {
	se := s.sessionFrom(c)
	if se == nil {
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "sign in to continue", "code": "unauthenticated"})
		return
	}
	c.Set("session", se)
	ctx := store.WithActor(store.WithTenant(c.Request.Context(), se.TenantID), se.User.ID)
	c.Request = c.Request.WithContext(ctx)
	c.Next()
}

func (s *Server) sessionFrom(c *gin.Context) *store.Session {
	token, err := c.Cookie(sessionCookie)
	if err != nil || token == "" {
		return nil
	}
	se, err := s.db.SessionByToken(c.Request.Context(), auth.HashToken(token), sessionTTL)
	if err != nil {
		if !errors.Is(err, store.ErrNotFound) {
			log.Printf("session lookup: %v", err)
		}
		return nil
	}
	return se
}

func session(c *gin.Context) *store.Session {
	if v, ok := c.Get("session"); ok {
		return v.(*store.Session)
	}
	return nil
}

// can lets the request through only if the user's role has the permission.
func (s *Server) can(perm string) gin.HandlerFunc {
	return func(c *gin.Context) {
		se := session(c)
		if se == nil || !auth.Can(se.Role, perm, se.Grants) {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "your role doesn't allow this; ask an admin", "code": "forbidden", "permission": perm})
			return
		}
		c.Next()
	}
}

// canAny lets the request through if the role has at least one of the permissions.
func (s *Server) canAny(perms ...string) gin.HandlerFunc {
	return func(c *gin.Context) {
		se := session(c)
		if se != nil {
			for _, p := range perms {
				if auth.Can(se.Role, p, se.Grants) {
					c.Next()
					return
				}
			}
		}
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "your role doesn't allow this; ask an admin", "code": "forbidden"})
	}
}

// homeOrgOnly guards gateway actions: the gateway (and the ML pipeline) belong to the
// deployment's home organization; other organizations have none connected yet.
func (s *Server) homeOrgOnly(c *gin.Context) {
	if !s.isHomeOrg(c) {
		c.AbortWithStatusJSON(http.StatusConflict, gin.H{"error": "this organization has no gateway connected yet; contact support to connect one", "code": "no_gateway"})
		return
	}
	c.Next()
}

// isHomeOrg reports whether the signed-in organization is the deployment's home tenant.
func (s *Server) isHomeOrg(c *gin.Context) bool {
	home, err := s.db.HomeTenantID(c.Request.Context())
	se := session(c)
	return err == nil && se != nil && se.TenantID == home
}

// sameOrigin refuses state-changing requests sent by another website (on top of the
// SameSite=Lax cookie). Requests without an Origin header (curl, the gateway) pass.
func sameOrigin(allowed []string) gin.HandlerFunc {
	return func(c *gin.Context) {
		switch c.Request.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			c.Next()
			return
		}
		origin := c.GetHeader("Origin")
		if origin == "" {
			c.Next()
			return
		}
		u, err := url.Parse(origin)
		if err == nil {
			for _, h := range []string{c.Request.Host, c.GetHeader("X-Forwarded-Host")} {
				if h != "" && strings.EqualFold(u.Host, h) {
					c.Next()
					return
				}
			}
			for _, a := range allowed {
				if strings.EqualFold(strings.TrimRight(a, "/"), origin) {
					c.Next()
					return
				}
			}
		}
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "request from another site refused"})
	}
}

// actor is who is making the request, as shown in the activity log.
func actor(c *gin.Context) string {
	if se := session(c); se != nil {
		return se.User.DisplayName()
	}
	return "System"
}

// ---------- rate limiting ----------

// limiter allows n requests per window per key (client IP + route).
type limiter struct {
	mu     sync.Mutex
	n      int
	window time.Duration
	hits   map[string][]time.Time
}

func newLimiter(n int, window time.Duration) *limiter {
	return &limiter{n: n, window: window, hits: map[string][]time.Time{}}
}

func (l *limiter) allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	recent := l.hits[key][:0]
	for _, t := range l.hits[key] {
		if now.Sub(t) < l.window {
			recent = append(recent, t)
		}
	}
	if len(recent) >= l.n {
		l.hits[key] = recent
		return false
	}
	l.hits[key] = append(recent, now)
	if len(l.hits) > 10000 { // forget idle keys
		for k, v := range l.hits {
			if len(v) == 0 || now.Sub(v[len(v)-1]) > l.window {
				delete(l.hits, k)
			}
		}
	}
	return true
}

func (l *limiter) middleware(c *gin.Context) {
	if !l.allow(c.ClientIP() + " " + c.FullPath()) {
		c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{"error": "too many attempts; wait a few minutes and try again"})
		return
	}
	c.Next()
}

// ---------- helpers ----------

func badRequest(c *gin.Context, msg string) {
	c.JSON(http.StatusBadRequest, gin.H{"error": msg})
}

// appURL is the web app's address for links in emails: APP_URL, else the address the
// request came in on.
func (s *Server) appURL(c *gin.Context) string {
	if s.cfg.AppURL != "" {
		return strings.TrimRight(s.cfg.AppURL, "/")
	}
	if c == nil {
		return "http://localhost:3000"
	}
	scheme := "http"
	if c.Request.TLS != nil || strings.EqualFold(c.GetHeader("X-Forwarded-Proto"), "https") {
		scheme = "https"
	}
	host := c.GetHeader("X-Forwarded-Host")
	if host == "" {
		host = c.Request.Host
	}
	return scheme + "://" + host
}

func (s *Server) setSessionCookie(c *gin.Context, token string, maxAge int) {
	secure := s.cfg.CookieSecure || c.Request.TLS != nil || strings.EqualFold(c.GetHeader("X-Forwarded-Proto"), "https")
	http.SetCookie(c.Writer, &http.Cookie{
		Name: sessionCookie, Value: token, Path: "/", MaxAge: maxAge,
		HttpOnly: true, Secure: secure, SameSite: http.SameSiteLaxMode,
	})
}

// startSession signs the user in on this browser.
func (s *Server) startSession(c *gin.Context, userID, tenantID string) error {
	token, hash, err := auth.NewToken()
	if err != nil {
		return err
	}
	if err := s.db.CreateSession(c.Request.Context(), userID, tenantID, hash, c.ClientIP(), c.Request.UserAgent(), sessionTTL); err != nil {
		return err
	}
	s.setSessionCookie(c, token, int(sessionTTL.Seconds()))
	return nil
}

// systemEmail sends account email (verification, reset, invitation). It uses the SMTP
// server from the environment (SMTP_HOST, ...) if set, otherwise the email provider set up
// on the Notifications page of the organization (or of the home organization), otherwise
// it writes the message to the API log.
func (s *Server) systemEmail(ctx context.Context, tenantID string, m notify.Email) (notify.Result, error) {
	p := s.cfg.SMTP
	if p.Type != "smtp" {
		p = notify.EmailProvider{Type: "log"}
		for _, tid := range []string{tenantID, ""} {
			if tid == "" {
				tid, _ = s.db.HomeTenantID(ctx)
			}
			if tid == "" {
				continue
			}
			ns, err := s.db.NotificationsFor(ctx, tid)
			if err == nil && ns.Email.Type == "smtp" && ns.Email.Unlock(s.box) == nil {
				p = ns.Email
				break
			}
		}
	}
	res, err := notify.SendEmail(ctx, p, m)
	if err != nil {
		log.Printf("account email to %s failed: %v", m.To, err)
	}
	return res, err
}

// mailed is the response after sending a link by email; with EMAIL_LINKS_IN_RESPONSE=true
// and no email provider, the link is returned too (for demos without a mail server).
func (s *Server) mailed(res notify.Result, link string, extra gin.H) gin.H {
	out := gin.H{"ok": true, "email_delivery": string(res)}
	if res == notify.Logged && s.cfg.LinksInResponse {
		out["dev_link"] = link
	}
	for k, v := range extra {
		out[k] = v
	}
	return out
}

func (s *Server) sendVerification(c *gin.Context, u store.User, tenantID string) (notify.Result, string, error) {
	token, hash, err := auth.NewToken()
	if err != nil {
		return "", "", err
	}
	if err := s.db.CreateUserToken(c.Request.Context(), u.ID, "verify_email", hash, verifyTTL); err != nil {
		return "", "", err
	}
	link := s.appURL(c) + "/verify-email?token=" + url.QueryEscape(token)
	res, err := s.systemEmail(c.Request.Context(), tenantID, notify.Email{
		To: u.Email, Subject: "Verify your email for FallGuard",
		Text: fmt.Sprintf("Hi %s,\n\nConfirm your email address to finish setting up your FallGuard account:\n\n%s\n\n"+
			"The link expires in 48 hours. If you didn't sign up, ignore this email.\n\n— FallGuard", u.FirstName, link),
	})
	return res, link, err
}

// ---------- public routes ----------

type signupInput struct {
	OrgName   string `json:"org_name"`
	FirstName string `json:"first_name"`
	LastName  string `json:"last_name"`
	Email     string `json:"email"`
	Password  string `json:"password"`
}

func (s *Server) signup(c *gin.Context) {
	var in signupInput
	if err := c.ShouldBindJSON(&in); err != nil {
		badRequest(c, "invalid JSON")
		return
	}
	org, err := auth.CleanName(in.OrgName, "organization name", 120)
	if err != nil {
		badRequest(c, err.Error())
		return
	}
	first, err := auth.CleanName(in.FirstName, "first name", 60)
	if err != nil {
		badRequest(c, err.Error())
		return
	}
	last, err := auth.CleanName(in.LastName, "last name", 60)
	if err != nil {
		badRequest(c, err.Error())
		return
	}
	email, err := auth.NormalizeEmail(in.Email)
	if err != nil {
		badRequest(c, err.Error())
		return
	}
	if err := auth.CheckPassword(in.Password, email); err != nil {
		badRequest(c, err.Error())
		return
	}
	hash, err := auth.HashPassword(in.Password)
	if err != nil {
		fail(c, err)
		return
	}
	userID, tenantID, err := s.db.CreateAccount(c.Request.Context(), org, first, last, email, hash)
	if errors.Is(err, store.ErrEmailTaken) {
		c.JSON(http.StatusConflict, gin.H{"error": "an account with this email already exists; sign in or reset your password", "code": "email_taken"})
		return
	}
	if err != nil {
		fail(c, err)
		return
	}
	// REQUIRE_EMAIL_VERIFICATION=false (demos): no email, signed in right away. The address
	// stays unverified, so turning verification back on asks these users to verify then.
	if !s.cfg.RequireEmailVerification {
		if err := s.startSession(c, userID, tenantID); err != nil {
			fail(c, err)
			return
		}
		c.JSON(http.StatusCreated, gin.H{"ok": true, "email": email, "signed_in": true})
		return
	}
	res, link, _ := s.sendVerification(c, store.User{ID: userID, Email: email, FirstName: first}, tenantID)
	c.JSON(http.StatusCreated, s.mailed(res, link, gin.H{"email": email}))
}

// authConfig tells the sign-in pages how accounts work on this server (public).
func (s *Server) authConfig(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"email_verification": s.cfg.RequireEmailVerification})
}

func (s *Server) login(c *gin.Context) {
	var in struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		badRequest(c, "invalid JSON")
		return
	}
	email, _ := auth.NormalizeEmail(in.Email)
	wrong := func() {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "wrong email or password", "code": "bad_credentials"})
	}
	u, err := s.db.UserByEmail(c.Request.Context(), email)
	if errors.Is(err, store.ErrNotFound) || email == "" {
		auth.SpendPasswordTime(in.Password)
		wrong()
		return
	}
	if err != nil {
		fail(c, err)
		return
	}
	if u.LockedUntil != nil && time.Now().Before(*u.LockedUntil) {
		mins := int(time.Until(*u.LockedUntil).Minutes()) + 1
		c.JSON(http.StatusTooManyRequests, gin.H{"error": fmt.Sprintf("too many wrong passwords: try again in %d minutes or reset your password", mins), "code": "locked"})
		return
	}
	if !auth.PasswordMatches(u.PasswordHash, in.Password) {
		if err := s.db.LoginFailed(c.Request.Context(), u.ID); err != nil {
			log.Printf("login failed count: %v", err)
		}
		wrong()
		return
	}
	if !u.EmailVerified && s.cfg.RequireEmailVerification {
		c.JSON(http.StatusForbidden, gin.H{"error": "verify your email first: check your inbox for the link", "code": "email_not_verified"})
		return
	}
	if err := s.startSession(c, u.ID, ""); err != nil {
		if errors.Is(err, store.ErrNoMembership) {
			c.JSON(http.StatusForbidden, gin.H{"error": err.Error(), "code": "no_membership"})
			return
		}
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (s *Server) logout(c *gin.Context) {
	if token, err := c.Cookie(sessionCookie); err == nil && token != "" {
		if err := s.db.DeleteSession(c.Request.Context(), auth.HashToken(token)); err != nil {
			log.Printf("logout: %v", err)
		}
	}
	s.setSessionCookie(c, "", -1)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (s *Server) verifyEmail(c *gin.Context) {
	var in struct {
		Token string `json:"token"`
	}
	if err := c.ShouldBindJSON(&in); err != nil || in.Token == "" {
		badRequest(c, "token is required")
		return
	}
	userID, err := s.db.VerifyEmail(c.Request.Context(), auth.HashToken(in.Token))
	if errors.Is(err, store.ErrTokenInvalid) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "this verification link is invalid, expired or already used; sign in to get a new one", "code": "token_invalid"})
		return
	}
	if err != nil {
		fail(c, err)
		return
	}
	// The link proves the address: sign the user in right away.
	if err := s.startSession(c, userID, ""); err != nil && !errors.Is(err, store.ErrNoMembership) {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// resendVerification always answers ok, so it doesn't reveal which emails have accounts.
func (s *Server) resendVerification(c *gin.Context) {
	var in struct {
		Email string `json:"email"`
	}
	_ = c.ShouldBindJSON(&in)
	out := gin.H{"ok": true}
	if email, err := auth.NormalizeEmail(in.Email); err == nil {
		if u, err := s.db.UserByEmail(c.Request.Context(), email); err == nil && !u.EmailVerified {
			res, link, _ := s.sendVerification(c, u.User, "")
			out = s.mailed(res, link, nil)
		}
	}
	c.JSON(http.StatusOK, out)
}

// forgotPassword always answers ok, so it doesn't reveal which emails have accounts.
func (s *Server) forgotPassword(c *gin.Context) {
	var in struct {
		Email string `json:"email"`
	}
	_ = c.ShouldBindJSON(&in)
	out := gin.H{"ok": true}
	if email, err := auth.NormalizeEmail(in.Email); err == nil {
		if u, err := s.db.UserByEmail(c.Request.Context(), email); err == nil {
			token, hash, err := auth.NewToken()
			if err == nil {
				err = s.db.CreateUserToken(c.Request.Context(), u.ID, "reset_password", hash, resetTTL)
			}
			if err != nil {
				fail(c, err)
				return
			}
			link := s.appURL(c) + "/reset-password?token=" + url.QueryEscape(token)
			res, _ := s.systemEmail(c.Request.Context(), "", notify.Email{
				To: u.Email, Subject: "Reset your FallGuard password",
				Text: fmt.Sprintf("Hi %s,\n\nSomeone asked to reset the password of your FallGuard account. To choose a new one, open:\n\n%s\n\n"+
					"The link expires in 1 hour. If it wasn't you, ignore this email: your password stays the same.\n\n— FallGuard", u.FirstName, link),
			})
			out = s.mailed(res, link, nil)
		}
	}
	c.JSON(http.StatusOK, out)
}

func (s *Server) resetPassword(c *gin.Context) {
	var in struct {
		Token    string `json:"token"`
		Password string `json:"password"`
	}
	if err := c.ShouldBindJSON(&in); err != nil || in.Token == "" {
		badRequest(c, "token and password are required")
		return
	}
	if err := auth.CheckPassword(in.Password, ""); err != nil {
		badRequest(c, err.Error())
		return
	}
	hash, err := auth.HashPassword(in.Password)
	if err != nil {
		fail(c, err)
		return
	}
	if _, err := s.db.ResetPassword(c.Request.Context(), auth.HashToken(in.Token), hash); err != nil {
		if errors.Is(err, store.ErrTokenInvalid) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "this reset link is invalid, expired or already used; ask for a new one", "code": "token_invalid"})
			return
		}
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (s *Server) invitationInfo(c *gin.Context) {
	info, err := s.db.InvitationByToken(c.Request.Context(), auth.HashToken(c.Param("token")))
	if errors.Is(err, store.ErrTokenInvalid) {
		c.JSON(http.StatusNotFound, gin.H{"error": "this invitation is invalid, expired, cancelled or already used; ask an admin to invite you again", "code": "token_invalid"})
		return
	}
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, info)
}

// acceptInvitation: a new person sends their name and a password; someone who already has
// an account sends their password (the account of the invited email).
func (s *Server) acceptInvitation(c *gin.Context) {
	var in struct {
		FirstName string `json:"first_name"`
		LastName  string `json:"last_name"`
		Password  string `json:"password"`
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		badRequest(c, "invalid JSON")
		return
	}
	ctx := c.Request.Context()
	hash := auth.HashToken(c.Param("token"))
	info, err := s.db.InvitationByToken(ctx, hash)
	if errors.Is(err, store.ErrTokenInvalid) {
		c.JSON(http.StatusNotFound, gin.H{"error": "this invitation is invalid, expired, cancelled or already used", "code": "token_invalid"})
		return
	}
	if err != nil {
		fail(c, err)
		return
	}
	var userID, tenantID string
	if info.AccountExists {
		u, err := s.db.UserByEmail(ctx, info.Email)
		if err == nil && u.LockedUntil != nil && time.Now().Before(*u.LockedUntil) {
			c.JSON(http.StatusTooManyRequests, gin.H{"error": "too many wrong passwords: try again later or reset your password", "code": "locked"})
			return
		}
		if err != nil || !auth.PasswordMatches(u.PasswordHash, in.Password) {
			if err == nil {
				_ = s.db.LoginFailed(ctx, u.ID)
			}
			c.JSON(http.StatusUnauthorized, gin.H{"error": "wrong password for " + info.Email, "code": "bad_credentials"})
			return
		}
		userID, tenantID, err = s.db.AcceptInvitation(ctx, hash, u.FirstName, u.LastName, "", u.ID)
		if err != nil {
			fail(c, err)
			return
		}
	} else {
		first, err := auth.CleanName(in.FirstName, "first name", 60)
		if err != nil {
			badRequest(c, err.Error())
			return
		}
		last, err := auth.CleanName(in.LastName, "last name", 60)
		if err != nil {
			badRequest(c, err.Error())
			return
		}
		if err := auth.CheckPassword(in.Password, info.Email); err != nil {
			badRequest(c, err.Error())
			return
		}
		pw, err := auth.HashPassword(in.Password)
		if err != nil {
			fail(c, err)
			return
		}
		userID, tenantID, err = s.db.AcceptInvitation(ctx, hash, first, last, pw, "")
		if errors.Is(err, store.ErrTokenInvalid) {
			c.JSON(http.StatusNotFound, gin.H{"error": "this invitation was already used", "code": "token_invalid"})
			return
		}
		if errors.Is(err, store.ErrEmailTaken) {
			c.JSON(http.StatusConflict, gin.H{"error": "an account with this email already exists; reload the page", "code": "email_taken"})
			return
		}
		if err != nil {
			fail(c, err)
			return
		}
	}
	if err := s.startSession(c, userID, tenantID); err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// authCheck answers nginx's auth_request for stream-hub (live video, clips, snapshots):
// 204 with a valid session that may watch video, otherwise 401 / 403.
func (s *Server) authCheck(c *gin.Context) {
	se := s.sessionFrom(c)
	switch {
	case se == nil:
		c.Status(http.StatusUnauthorized)
	case !auth.Can(se.Role, auth.ViewLive, se.Grants) && !auth.Can(se.Role, auth.ViewEvents, se.Grants):
		c.Status(http.StatusForbidden)
	default:
		c.Status(http.StatusNoContent)
	}
}

// ---------- signed-in routes ----------

func (s *Server) me(c *gin.Context) {
	se := session(c)
	orgs, err := s.db.UserOrgs(c.Request.Context(), se.User.ID)
	if err != nil {
		fail(c, err)
		return
	}
	home, _ := s.db.HomeTenantID(c.Request.Context())
	c.JSON(http.StatusOK, gin.H{
		"user":        se.User,
		"org":         gin.H{"id": se.TenantID, "name": se.OrgName, "has_gateway": se.TenantID == home},
		"role":        se.Role,
		"permissions": auth.Allowed(se.Role, se.Grants),
		"orgs":        orgs,
	})
}

func (s *Server) updateMe(c *gin.Context) {
	var in struct {
		FirstName string  `json:"first_name"`
		LastName  string  `json:"last_name"`
		Phone     *string `json:"phone"`
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		badRequest(c, "invalid JSON")
		return
	}
	first, err := auth.CleanName(in.FirstName, "first name", 60)
	if err != nil {
		badRequest(c, err.Error())
		return
	}
	last, err := auth.CleanName(in.LastName, "last name", 60)
	if err != nil {
		badRequest(c, err.Error())
		return
	}
	var phone *string
	if in.Phone != nil && strings.TrimSpace(*in.Phone) != "" {
		p := strings.NewReplacer(" ", "", "-", "", "(", "", ")", "", ".", "").Replace(*in.Phone)
		if !notify.E164.MatchString(p) {
			badRequest(c, "phone must be in international format, e.g. +14165550123")
			return
		}
		phone = &p
	}
	if err := s.db.UpdateProfile(c.Request.Context(), session(c).User.ID, first, last, phone); err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (s *Server) changePassword(c *gin.Context) {
	var in struct {
		Current string `json:"current_password"`
		New     string `json:"new_password"`
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		badRequest(c, "invalid JSON")
		return
	}
	se := session(c)
	u, err := s.db.UserByID(c.Request.Context(), se.User.ID)
	if err != nil {
		fail(c, err)
		return
	}
	if !auth.PasswordMatches(u.PasswordHash, in.Current) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "current password is wrong", "code": "bad_credentials"})
		return
	}
	if err := auth.CheckPassword(in.New, u.Email); err != nil {
		badRequest(c, err.Error())
		return
	}
	hash, err := auth.HashPassword(in.New)
	if err != nil {
		fail(c, err)
		return
	}
	if err := s.db.SetPassword(c.Request.Context(), u.ID, hash); err != nil {
		fail(c, err)
		return
	}
	// Other browsers signed in with the old password are signed out.
	if err := s.db.DeleteUserSessions(c.Request.Context(), u.ID, se.ID); err != nil {
		log.Printf("sign out other sessions: %v", err)
	}
	_ = s.db.Audit(c.Request.Context(), actor(c), "user.password_changed", "user", u.ID, map[string]any{"message": "Password changed"})
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (s *Server) logoutAll(c *gin.Context) {
	if err := s.db.DeleteUserSessions(c.Request.Context(), session(c).User.ID, ""); err != nil {
		fail(c, err)
		return
	}
	s.setSessionCookie(c, "", -1)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (s *Server) switchOrg(c *gin.Context) {
	var in struct {
		OrgID string `json:"org_id"`
	}
	if err := c.ShouldBindJSON(&in); err != nil || in.OrgID == "" {
		badRequest(c, "org_id is required")
		return
	}
	se := session(c)
	if err := s.db.SwitchOrg(c.Request.Context(), se.ID, se.User.ID, in.OrgID); err != nil {
		if errors.Is(err, store.ErrNotMemberOfOrg) {
			c.JSON(http.StatusForbidden, gin.H{"error": err.Error()})
			return
		}
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
