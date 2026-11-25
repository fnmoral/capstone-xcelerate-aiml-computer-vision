package api

import (
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/gin-gonic/gin"

	"backend-api/internal/auth"
	"backend-api/internal/store"
)

// Demo access links: an admin creates a link that lasts a set time; whoever opens it is
// signed in to the organization as a view-only demo visitor, without an account.

// maxGuestHours caps how long a demo link can last (30 days).
const maxGuestHours = 30 * 24

func (s *Server) listGuestLinks(c *gin.Context) {
	list, err := s.db.GuestLinks(c.Request.Context())
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"links": list})
}

// createGuestLink: {label, hours}. The link (with its token) is returned only now.
func (s *Server) createGuestLink(c *gin.Context) {
	var in struct {
		Label string `json:"label"`
		Hours int    `json:"hours"`
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		badRequest(c, "invalid JSON")
		return
	}
	label, err := auth.CleanName(in.Label, "label", 60)
	if err != nil {
		badRequest(c, err.Error())
		return
	}
	if in.Hours < 1 || in.Hours > maxGuestHours {
		badRequest(c, "hours must be between 1 and 720 (30 days)")
		return
	}
	token, hash, err := auth.NewToken()
	if err != nil {
		fail(c, err)
		return
	}
	link, err := s.db.CreateGuestLink(c.Request.Context(), label, hash, time.Now().Add(time.Duration(in.Hours)*time.Hour), actor(c))
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"link": link, "url": s.appURL(c) + "/demo/" + url.PathEscape(token)})
}

func (s *Server) revokeGuestLink(c *gin.Context) {
	if err := s.db.RevokeGuestLink(c.Request.Context(), c.Param("id"), actor(c)); err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (s *Server) guestEntry(c *gin.Context) (*store.GuestEntry, bool) {
	e, err := s.db.GuestLinkByToken(c.Request.Context(), auth.HashToken(c.Param("token")))
	if errors.Is(err, store.ErrTokenInvalid) {
		c.JSON(http.StatusNotFound, gin.H{"error": "this demo link has expired or was turned off; ask the team for a new one", "code": "token_invalid"})
		return nil, false
	}
	if err != nil {
		fail(c, err)
		return nil, false
	}
	return e, true
}

// guestInfo (public): which organization the demo link opens, and until when.
func (s *Server) guestInfo(c *gin.Context) {
	if e, ok := s.guestEntry(c); ok {
		c.JSON(http.StatusOK, e)
	}
}

// guestEnter (public): signs this browser in as the link's demo visitor until the link ends.
func (s *Server) guestEnter(c *gin.Context) {
	e, ok := s.guestEntry(c)
	if !ok {
		return
	}
	ttl := time.Until(e.ExpiresAt)
	if ttl > sessionTTL {
		ttl = sessionTTL
	}
	token, hash, err := auth.NewToken()
	if err != nil {
		fail(c, err)
		return
	}
	if err := s.db.CreateSession(c.Request.Context(), e.UserID, e.TenantID, hash, c.ClientIP(), c.Request.UserAgent(), ttl); err != nil {
		fail(c, err)
		return
	}
	if err := s.db.GuestVisited(c.Request.Context(), e); err != nil {
		log.Printf("demo link visit count: %v", err)
	}
	s.setSessionCookie(c, token, int(ttl.Seconds()))
	c.JSON(http.StatusOK, gin.H{"ok": true, "expires_at": e.ExpiresAt})
}

// setVisitorName (demo visitors only): {name}, optional; "" = skip. Their actions are then
// logged under that name, e.g. "Sam (visitor)".
func (s *Server) setVisitorName(c *gin.Context) {
	se := session(c)
	if !se.User.IsGuest {
		c.JSON(http.StatusForbidden, gin.H{"error": "only for temporary access visitors", "code": "forbidden"})
		return
	}
	var in struct {
		Name string `json:"name"`
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		badRequest(c, "invalid JSON")
		return
	}
	name := cleanVisitorName(in.Name)
	if utf8.RuneCountInString(name) > store.VisitorNameMax {
		badRequest(c, fmt.Sprintf("name must be at most %d characters", store.VisitorNameMax))
		return
	}
	if err := s.db.SetVisitorName(c.Request.Context(), se.ID, name); err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "visitor_name": name})
}

// cleanVisitorName drops control characters and runs of spaces.
func cleanVisitorName(s string) string {
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, s)
	return strings.Join(strings.Fields(s), " ")
}

// notGuest refuses account self-service (profile, password, organizations) to demo visitors.
func (s *Server) notGuest(c *gin.Context) {
	if se := session(c); se != nil && se.User.IsGuest {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "demo access is view-only", "code": "forbidden"})
		return
	}
	c.Next()
}
