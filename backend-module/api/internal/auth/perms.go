// Package auth holds the role and permission rules, password hashing and token helpers.
// It has no database or HTTP code, so the rules can be unit tested on their own.
package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/mail"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/crypto/bcrypt"
)

// Roles, most powerful first.
const (
	RoleAdmin  = "admin"
	RoleMember = "member"
	RoleViewer = "viewer"
)

// Roles lists the roles in display order.
var Roles = []string{RoleAdmin, RoleMember, RoleViewer}

// ValidRole reports whether r is one of the roles.
func ValidRole(r string) bool { return slices.Contains(Roles, r) }

// Permission is one thing a role can be allowed to do.
type Permission struct {
	Key         string `json:"key"`
	Group       string `json:"group"`
	Label       string `json:"label"`
	Description string `json:"description"`
	// AdminOnly permissions can't be granted to members or viewers: managing people and
	// roles stays with admins (promote someone to admin to share it).
	AdminOnly bool `json:"admin_only"`
}

// Permission keys.
const (
	ViewLive            = "live.view"
	ViewEvents          = "events.view"
	ViewAnalytics       = "analytics.view"
	ViewReports         = "reports.view"
	ViewLogs            = "logs.view"
	ManageAlerts        = "alerts.manage"
	CreateReports       = "incident_reports.manage"
	ManageCameras       = "cameras.manage"
	ManageDetection     = "detection.manage"
	ManageNotifications = "notifications.manage"
	ManageSettings      = "settings.manage"
	ViewMembers         = "members.view"
	ManageMembers       = "members.manage"
	ManageRoles         = "roles.manage"
)

// Catalog is every permission, in the order the Members page shows them.
var Catalog = []Permission{
	{ViewLive, "Monitor", "View live cameras", "Watch the Live View and camera status.", false},
	{ViewEvents, "Monitor", "View fall events", "See fall events, incident details, snapshots and clips.", false},
	{ViewAnalytics, "Monitor", "View analytics", "See the analytics dashboard.", false},
	{ViewReports, "Monitor", "View reports and export", "Open reports, incident reports and download CSV exports.", false},
	{ViewLogs, "Monitor", "View logs", "See camera logs and the activity log.", false},
	{ManageAlerts, "Respond", "Respond to alerts", "Acknowledge, resolve or mark false alarms, change incident status, add notes.", false},
	{CreateReports, "Respond", "Write incident reports", "Create, edit and delete WSIB / OHSA / OSHA / internal incident reports.", false},
	{ManageCameras, "Configure", "Manage cameras and layout", "Add, edit, pause, remove and reorder cameras.", false},
	{ManageDetection, "Configure", "Change detection settings", "Change the pose model, device and detection thresholds.", false},
	{ManageNotifications, "Configure", "Manage notifications", "Change who is notified, how, templates and email / SMS providers.", false},
	{ManageSettings, "Configure", "Manage organization settings", "Change the organization profile, time zone and gateway connection.", false},
	{ViewMembers, "People", "View members", "See who is in the organization and their roles.", false},
	{ManageMembers, "People", "Manage members", "Invite and remove members and change their roles.", true},
	{ManageRoles, "People", "Manage role permissions", "Change what members and viewers are allowed to do.", true},
}

// Known reports whether key is in the catalog.
func Known(key string) bool {
	for _, p := range Catalog {
		if p.Key == key {
			return true
		}
	}
	return false
}

func adminOnly(key string) bool {
	for _, p := range Catalog {
		if p.Key == key {
			return p.AdminOnly
		}
	}
	return false
}

// DefaultGrants is what members and viewers may do in a new organization.
// Admins always have every permission.
func DefaultGrants() map[string][]string {
	member := []string{}
	for _, p := range Catalog {
		if !p.AdminOnly {
			member = append(member, p.Key)
		}
	}
	return map[string][]string{
		RoleMember: member,
		RoleViewer: {ViewLive, ViewEvents, ViewAnalytics, ViewReports, ViewLogs, ViewMembers},
	}
}

// Normalize cleans an organization's saved grants: unknown keys and admin-only
// permissions are dropped, roles that were never saved get the defaults.
func Normalize(saved map[string][]string) map[string][]string {
	def := DefaultGrants()
	out := map[string][]string{}
	for _, role := range []string{RoleMember, RoleViewer} {
		keys, ok := saved[role]
		if !ok {
			keys = def[role]
		}
		clean := []string{}
		for _, k := range keys {
			if Known(k) && !adminOnly(k) && !slices.Contains(clean, k) {
				clean = append(clean, k)
			}
		}
		out[role] = clean
	}
	return out
}

// Allowed lists what a role may do, given the organization's grants.
func Allowed(role string, grants map[string][]string) []string {
	if role == RoleAdmin {
		all := make([]string, len(Catalog))
		for i, p := range Catalog {
			all[i] = p.Key
		}
		return all
	}
	return Normalize(grants)[role]
}

// Can reports whether role may do perm.
func Can(role, perm string, grants map[string][]string) bool {
	return slices.Contains(Allowed(role, grants), perm)
}

// ---------- passwords ----------

// MinPasswordLength is the shortest password accepted.
const MinPasswordLength = 10

// CheckPassword returns why a password isn't accepted, or nil.
// bcrypt only reads the first 72 bytes, so longer passwords are refused rather than cut.
func CheckPassword(pw, email string) error {
	if utf8.RuneCountInString(pw) < MinPasswordLength {
		return fmt.Errorf("password must be at least %d characters", MinPasswordLength)
	}
	if len(pw) > 72 {
		return errors.New("password must be at most 72 bytes")
	}
	var letter, digit bool
	for _, r := range pw {
		letter = letter || unicode.IsLetter(r)
		digit = digit || unicode.IsDigit(r) || unicode.IsPunct(r) || unicode.IsSymbol(r)
	}
	if !letter || !digit {
		return errors.New("password must contain letters and at least one number or symbol")
	}
	if email != "" && strings.EqualFold(pw, email) {
		return errors.New("password can't be your email address")
	}
	return nil
}

// HashPassword hashes a password with bcrypt.
func HashPassword(pw string) (string, error) {
	h, err := bcrypt.GenerateFromPassword([]byte(pw), 12)
	return string(h), err
}

// PasswordMatches compares a password with a stored bcrypt hash. Hashes that aren't
// bcrypt (demo seed placeholders) never match.
func PasswordMatches(hash, pw string) bool {
	if !strings.HasPrefix(hash, "$2") {
		return false
	}
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(pw)) == nil
}

// dummyHash is compared against when the email is unknown, so a failed sign-in takes the
// same time whether or not the account exists.
var dummyHash, _ = bcrypt.GenerateFromPassword([]byte("not-a-real-password-0"), 12)

// SpendPasswordTime does the work of a password check without an account.
func SpendPasswordTime(pw string) { _ = bcrypt.CompareHashAndPassword(dummyHash, []byte(pw)) }

// ---------- tokens and input ----------

// NewToken returns a random URL-safe token and its SHA-256 hash (only the hash is stored).
func NewToken() (token, hash string, err error) {
	b := make([]byte, 32)
	if _, err = rand.Read(b); err != nil {
		return "", "", err
	}
	token = base64.RawURLEncoding.EncodeToString(b)
	return token, HashToken(token), nil
}

// HashToken is the stored form of a token.
func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// NormalizeEmail trims and lower-cases an email and checks it's a plain address.
func NormalizeEmail(s string) (string, error) {
	s = strings.ToLower(strings.TrimSpace(s))
	a, err := mail.ParseAddress(s)
	if err != nil || a.Address != s || len(s) > 254 || !strings.Contains(s[strings.LastIndex(s, "@"):], ".") {
		return "", errors.New("enter a valid email address")
	}
	return s, nil
}

// CleanName trims a person or organization name and checks its length.
func CleanName(s, what string, max int) (string, error) {
	s = strings.Join(strings.Fields(s), " ")
	if s == "" {
		return "", fmt.Errorf("%s is required", what)
	}
	if utf8.RuneCountInString(s) > max {
		return "", fmt.Errorf("%s must be at most %d characters", what, max)
	}
	for _, r := range s {
		if unicode.IsControl(r) || r == '<' || r == '>' {
			return "", fmt.Errorf("%s contains characters that aren't allowed", what)
		}
	}
	return s, nil
}
