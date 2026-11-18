package api

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/gin-gonic/gin"

	"backend-api/internal/auth"
	"backend-api/internal/notify"
	"backend-api/internal/store"
)

// orgErr answers the member-management errors with a clear status.
func orgErr(c *gin.Context, err error) {
	switch {
	case errors.Is(err, store.ErrLastAdmin), errors.Is(err, store.ErrAlreadyMember):
		c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
	default:
		fail(c, err)
	}
}

func (s *Server) listMembers(c *gin.Context) {
	ctx := c.Request.Context()
	members, err := s.db.Members(ctx)
	if err != nil {
		fail(c, err)
		return
	}
	out := gin.H{"members": members, "invitations": []store.Invitation{}}
	if se := session(c); auth.Can(se.Role, auth.ManageMembers, se.Grants) {
		inv, err := s.db.Invitations(ctx)
		if err != nil {
			fail(c, err)
			return
		}
		out["invitations"] = inv
	}
	c.JSON(http.StatusOK, out)
}

func (s *Server) sendInvitation(c *gin.Context, inv *store.Invitation, token string) gin.H {
	se := session(c)
	link := s.appURL(c) + "/invite/" + url.PathEscape(token)
	res, _ := s.systemEmail(c.Request.Context(), se.TenantID, notify.Email{
		To:      inv.Email,
		Subject: fmt.Sprintf("%s invited you to %s on FallGuard", se.User.DisplayName(), se.OrgName),
		Text: fmt.Sprintf("Hi,\n\n%s invited you to join %s on FallGuard as a %s.\n\nAccept the invitation:\n\n%s\n\n"+
			"The link expires in 7 days.\n\n— FallGuard", se.User.DisplayName(), se.OrgName, inv.Role, link),
	})
	return s.mailed(res, link, gin.H{"invitation": inv})
}

func (s *Server) invite(c *gin.Context) {
	var in struct {
		Email string `json:"email"`
		Role  string `json:"role"`
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		badRequest(c, "invalid JSON")
		return
	}
	email, err := auth.NormalizeEmail(in.Email)
	if err != nil {
		badRequest(c, err.Error())
		return
	}
	if !auth.ValidRole(in.Role) {
		badRequest(c, "role must be admin, member or viewer")
		return
	}
	token, hash, err := auth.NewToken()
	if err != nil {
		fail(c, err)
		return
	}
	inv, err := s.db.CreateInvitation(c.Request.Context(), email, in.Role, hash, actor(c), inviteTTL)
	if err != nil {
		orgErr(c, err)
		return
	}
	c.JSON(http.StatusCreated, s.sendInvitation(c, inv, token))
}

func (s *Server) resendInvitation(c *gin.Context) {
	token, hash, err := auth.NewToken()
	if err != nil {
		fail(c, err)
		return
	}
	inv, err := s.db.RenewInvitation(c.Request.Context(), c.Param("id"), hash, actor(c), inviteTTL)
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, s.sendInvitation(c, inv, token))
}

func (s *Server) revokeInvitation(c *gin.Context) {
	if err := s.db.RevokeInvitation(c.Request.Context(), c.Param("id"), actor(c)); err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (s *Server) setMemberRole(c *gin.Context) {
	var in struct {
		Role string `json:"role"`
	}
	if err := c.ShouldBindJSON(&in); err != nil || !auth.ValidRole(in.Role) {
		badRequest(c, "role must be admin, member or viewer")
		return
	}
	if err := s.db.SetMemberRole(c.Request.Context(), c.Param("id"), in.Role, actor(c)); err != nil {
		orgErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (s *Server) removeMember(c *gin.Context) {
	if err := s.db.RemoveMember(c.Request.Context(), c.Param("id"), actor(c)); err != nil {
		orgErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// leaveOrg takes the signed-in user out of the current organization.
func (s *Server) leaveOrg(c *gin.Context) {
	se := session(c)
	if err := s.db.RemoveMember(c.Request.Context(), se.User.ID, actor(c)); err != nil {
		orgErr(c, err)
		return
	}
	s.setSessionCookie(c, "", -1)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// rolePermissions: the permission catalog, what each role may do, and the roles' descriptions.
func (s *Server) rolePermissions(c *gin.Context) {
	grants, err := s.db.RoleGrants(c.Request.Context())
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"catalog": auth.Catalog,
		"roles": gin.H{
			auth.RoleAdmin:  auth.Allowed(auth.RoleAdmin, grants),
			auth.RoleMember: grants[auth.RoleMember],
			auth.RoleViewer: grants[auth.RoleViewer],
		},
		"defaults": auth.DefaultGrants(),
	})
}

func (s *Server) saveRolePermissions(c *gin.Context) {
	var in struct {
		Roles map[string][]string `json:"roles"`
	}
	if err := c.ShouldBindJSON(&in); err != nil || in.Roles == nil {
		badRequest(c, "roles: {member: [...], viewer: [...]}")
		return
	}
	for role, keys := range in.Roles {
		if role != auth.RoleMember && role != auth.RoleViewer {
			badRequest(c, "only member and viewer permissions can be changed (admins can do everything)")
			return
		}
		for _, k := range keys {
			if !auth.Known(k) {
				badRequest(c, "unknown permission "+k)
				return
			}
		}
	}
	if err := s.db.SetRoleGrants(c.Request.Context(), in.Roles, actor(c)); err != nil {
		fail(c, err)
		return
	}
	s.rolePermissions(c)
}

func (s *Server) getOrg(c *gin.Context) {
	p, err := s.db.Org(c.Request.Context())
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, p)
}

func (s *Server) saveOrg(c *gin.Context) {
	var in store.OrgProfile
	if err := c.ShouldBindJSON(&in); err != nil {
		badRequest(c, "invalid JSON")
		return
	}
	name, err := auth.CleanName(in.Name, "organization name", 120)
	if err != nil {
		badRequest(c, err.Error())
		return
	}
	in.Name = name
	for _, f := range []*string{&in.LegalName, &in.Address, &in.City, &in.Province, &in.PostalCode, &in.Country,
		&in.Phone, &in.WSIBFirmNo, &in.WSIBRateGroup, &in.BusinessType, &in.Establishment} {
		*f = strings.TrimSpace(*f)
		if len(*f) > 200 {
			badRequest(c, "organization details must be at most 200 characters each")
			return
		}
	}
	if err := s.db.SetOrg(c.Request.Context(), in, actor(c)); err != nil {
		fail(c, err)
		return
	}
	s.getOrg(c)
}
