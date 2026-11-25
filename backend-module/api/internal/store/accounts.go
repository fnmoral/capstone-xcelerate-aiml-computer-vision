package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"backend-api/internal/auth"
)

// Account errors the API turns into clear messages.
var (
	ErrEmailTaken     = errors.New("an account with this email already exists")
	ErrTokenInvalid   = errors.New("this link is invalid or has expired")
	ErrLastAdmin      = errors.New("an organization needs at least one admin: make someone else an admin first")
	ErrAlreadyMember  = errors.New("this person is already a member of the organization")
	ErrNoMembership   = errors.New("you aren't a member of any organization; ask an admin to invite you")
	ErrNotMemberOfOrg = errors.New("you aren't a member of that organization")
)

type actorKey struct{}

// WithActor returns a context whose audit log entries record this user ID.
func WithActor(ctx context.Context, userID string) context.Context {
	return context.WithValue(ctx, actorKey{}, userID)
}

func actorID(ctx context.Context) *string {
	if id, ok := ctx.Value(actorKey{}).(string); ok && id != "" {
		return &id
	}
	return nil
}

// User is an account as the app shows it.
type User struct {
	ID            string     `json:"id"`
	Email         string     `json:"email"`
	FirstName     string     `json:"first_name"`
	LastName      string     `json:"last_name"`
	Phone         *string    `json:"phone"`
	EmailVerified bool       `json:"email_verified"`
	LastLoginAt   *time.Time `json:"last_login_at"`
	CreatedAt     time.Time  `json:"created_at"`

	// Demo visitor (signed in through a demo access link): view-only until AccessUntil.
	IsGuest     bool       `json:"is_guest,omitempty"`
	AccessUntil *time.Time `json:"access_until,omitempty"`

	// VisitorName: the name a demo visitor gave in this browser; absent = not asked yet,
	// "" = skipped (then they appear as "Demo visitor <link label>").
	VisitorName *string `json:"visitor_name,omitempty"`
}

// DisplayName is "First Last", or the email if the name is empty.
func (u User) DisplayName() string {
	if n := strings.TrimSpace(u.FirstName + " " + u.LastName); n != "" {
		return n
	}
	return u.Email
}

// LoginUser is a user with what sign-in needs.
type LoginUser struct {
	User
	PasswordHash string
	FailedLogins int
	LockedUntil  *time.Time
	LastTenantID *string
}

// Org is an organization the user belongs to, with their role in it.
type Org struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Role string `json:"role"`
}

// Session is a signed-in browser.
type Session struct {
	ID        string
	User      User
	TenantID  string
	OrgName   string
	Role      string
	Grants    map[string][]string
	ExpiresAt time.Time
}

const userColumns = `u.id::text, u.email::text, coalesce(u.first_name, ''), coalesce(u.last_name, ''), u.phone,
	u.email_verified_at IS NOT NULL, u.last_login_at, u.created_at`

func scanUser(r pgx.Row, u *User, extra ...any) error {
	return r.Scan(append([]any{&u.ID, &u.Email, &u.FirstName, &u.LastName, &u.Phone, &u.EmailVerified,
		&u.LastLoginAt, &u.CreatedAt}, extra...)...)
}

// plain runs fn in a transaction without a tenant (accounts span organizations).
func (s *Store) plain(ctx context.Context, fn func(pgx.Tx) error) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op after commit
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

var slugChars = regexp.MustCompile(`[^a-z0-9]+`)

func newSlug(name string) string {
	base := strings.Trim(slugChars.ReplaceAllString(strings.ToLower(name), "-"), "-")
	if len(base) > 40 {
		base = strings.Trim(base[:40], "-")
	}
	if base == "" {
		base = "org"
	}
	b := make([]byte, 3)
	_, _ = rand.Read(b)
	return base + "-" + hex.EncodeToString(b)
}

// usableMembers counts members of a tenant who can actually sign in (real password hash).
const usableMembers = `SELECT count(*) FROM memberships m JOIN users u ON u.id = m.user_id
	WHERE m.tenant_id = $1 AND u.password_hash LIKE '$2%'`

// CreateAccount signs up a new user with a new organization, as its admin. The email is
// not verified yet. The first sign-up on a deployment takes over the home tenant (the one
// with the gateway, cameras and fall history) instead of starting an empty organization.
func (s *Store) CreateAccount(ctx context.Context, orgName, first, last, email, pwHash string) (userID, tenantID string, err error) {
	err = s.plain(ctx, func(tx pgx.Tx) error {
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM users WHERE email = $1::citext)`, email).Scan(&exists); err != nil {
			return err
		}
		if exists {
			return ErrEmailTaken
		}
		if err := tx.QueryRow(ctx, `
			INSERT INTO users (email, password_hash, first_name, last_name, full_name, password_changed_at)
			VALUES ($1::citext, $2, $3, $4, $3 || ' ' || $4, now()) RETURNING id::text`,
			email, pwHash, first, last).Scan(&userID); err != nil {
			if isUnique(err, "users_email_key") {
				return ErrEmailTaken
			}
			return err
		}
		claimed, err := s.claimHomeTenant(ctx, tx, orgName)
		if err != nil {
			return err
		}
		tenantID = claimed
		if tenantID == "" {
			if err := tx.QueryRow(ctx, `INSERT INTO tenants (name, slug) VALUES ($1, $2) RETURNING id::text`,
				orgName, newSlug(orgName)).Scan(&tenantID); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, `INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'admin')`,
			tenantID, userID); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE users SET last_tenant_id = $2 WHERE id = $1`, userID, tenantID)
		if err != nil {
			return err
		}
		return auditTx(ctx, tx, tenantID, &userID, first+" "+last, "org.created", "org", tenantID,
			map[string]any{"message": "Organization created by sign-up", "name": orgName})
	})
	return userID, tenantID, err
}

// claimHomeTenant renames the home tenant to orgName and returns its ID if nobody who can
// sign in belongs to it yet (demo seed placeholders are dropped); otherwise "".
func (s *Store) claimHomeTenant(ctx context.Context, tx pgx.Tx, orgName string) (string, error) {
	home, err := s.HomeTenantID(ctx)
	if err != nil {
		return "", nil // no home tenant configured: just create a new organization
	}
	if _, err := tx.Exec(ctx, `SELECT 1 FROM tenants WHERE id = $1 FOR UPDATE`, home); err != nil {
		return "", err
	}
	var n int
	if err := tx.QueryRow(ctx, usableMembers, home).Scan(&n); err != nil {
		return "", err
	}
	if n > 0 {
		return "", nil
	}
	if _, err := tx.Exec(ctx, `DELETE FROM memberships m USING users u
		WHERE m.user_id = u.id AND m.tenant_id = $1 AND u.password_hash NOT LIKE '$2%'`, home); err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `UPDATE tenants SET name = $2 WHERE id = $1`, home, orgName); err != nil {
		return "", err
	}
	return home, nil
}

// UserByEmail returns the account for sign-in, or ErrNotFound.
func (s *Store) UserByEmail(ctx context.Context, email string) (*LoginUser, error) {
	var u LoginUser
	err := s.pool.QueryRow(ctx, `SELECT `+userColumns+`, coalesce(u.password_hash, ''), u.failed_logins,
		u.locked_until, u.last_tenant_id::text FROM users u WHERE u.email = $1::citext AND u.is_active
		AND u.guest_link_id IS NULL`, email).
		Scan(&u.ID, &u.Email, &u.FirstName, &u.LastName, &u.Phone, &u.EmailVerified, &u.LastLoginAt, &u.CreatedAt,
			&u.PasswordHash, &u.FailedLogins, &u.LockedUntil, &u.LastTenantID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	return &u, err
}

// UserByID returns an account with its password hash (for password changes).
func (s *Store) UserByID(ctx context.Context, id string) (*LoginUser, error) {
	var u LoginUser
	err := s.pool.QueryRow(ctx, `SELECT `+userColumns+`, coalesce(u.password_hash, ''), u.failed_logins,
		u.locked_until, u.last_tenant_id::text FROM users u WHERE u.id = $1`, id).
		Scan(&u.ID, &u.Email, &u.FirstName, &u.LastName, &u.Phone, &u.EmailVerified, &u.LastLoginAt, &u.CreatedAt,
			&u.PasswordHash, &u.FailedLogins, &u.LockedUntil, &u.LastTenantID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	return &u, err
}

// Lockout: this many wrong passwords in a row lock the account for LockoutFor.
const (
	MaxFailedLogins = 5
	LockoutFor      = 15 * time.Minute
)

// LoginFailed counts a wrong password and locks the account after MaxFailedLogins.
func (s *Store) LoginFailed(ctx context.Context, userID string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE users SET
		  locked_until  = CASE WHEN failed_logins + 1 >= $2 THEN now() + $3::interval ELSE locked_until END,
		  failed_logins = CASE WHEN failed_logins + 1 >= $2 THEN 0 ELSE failed_logins + 1 END
		WHERE id = $1`, userID, MaxFailedLogins, fmt.Sprintf("%d seconds", int(LockoutFor.Seconds())))
	return err
}

// UserOrgs lists the organizations a user belongs to.
func (s *Store) UserOrgs(ctx context.Context, userID string) ([]Org, error) {
	rows, err := s.pool.Query(ctx, `SELECT t.id::text, t.name, m.role FROM memberships m
		JOIN tenants t ON t.id = m.tenant_id WHERE m.user_id = $1 AND t.status = 'active' ORDER BY t.name`, userID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (Org, error) {
		var o Org
		err := r.Scan(&o.ID, &o.Name, &o.Role)
		return o, err
	})
}

// CreateSession signs a user in to one of their organizations (the last one used if
// tenantID is empty). tokenHash is the hash of the browser's cookie.
func (s *Store) CreateSession(ctx context.Context, userID, tenantID, tokenHash, ip, userAgent string, ttl time.Duration) error {
	return s.plain(ctx, func(tx pgx.Tx) error {
		if tenantID == "" {
			err := tx.QueryRow(ctx, `SELECT m.tenant_id::text FROM memberships m JOIN users u ON u.id = m.user_id
				JOIN tenants t ON t.id = m.tenant_id AND t.status = 'active'
				WHERE m.user_id = $1 ORDER BY (m.tenant_id = u.last_tenant_id) DESC, m.created_at LIMIT 1`, userID).Scan(&tenantID)
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrNoMembership
			}
			if err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, `INSERT INTO sessions (user_id, tenant_id, token_hash, expires_at, ip, user_agent)
			VALUES ($1, $2, $3, now() + $4::interval, $5, left($6, 300))`,
			userID, tenantID, tokenHash, fmt.Sprintf("%d seconds", int(ttl.Seconds())), ip, userAgent); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `UPDATE users SET last_login_at = now(), failed_logins = 0, locked_until = NULL,
			last_tenant_id = $2 WHERE id = $1`, userID, tenantID)
		if err != nil {
			return err
		}
		return auditTx(ctx, tx, tenantID, &userID, "", "user.signed_in", "user", userID,
			map[string]any{"message": "Signed in", "ip": ip})
	})
}

// SessionByToken returns the signed-in session for a cookie, or ErrNotFound when it's
// unknown, expired, or the user lost their membership. Sliding expiry: a session used
// with less than half of ttl left is extended to ttl.
func (s *Store) SessionByToken(ctx context.Context, tokenHash string, ttl time.Duration) (*Session, error) {
	var se Session
	var grants []byte
	var lastSeen time.Time
	var visitorName *string
	err := s.pool.QueryRow(ctx, `
		SELECT se.id::text, `+userColumns+`, se.tenant_id::text, t.name, m.role, t.role_permissions, se.expires_at, se.last_seen_at,
		       g.expires_at, se.visitor_name
		FROM sessions se
		JOIN users u ON u.id = se.user_id AND u.is_active
		JOIN memberships m ON m.user_id = se.user_id AND m.tenant_id = se.tenant_id
		JOIN tenants t ON t.id = se.tenant_id AND t.status = 'active'
		LEFT JOIN guest_links g ON g.id = u.guest_link_id
		WHERE se.token_hash = $1 AND se.expires_at > now()
		  AND (u.guest_link_id IS NULL OR (g.revoked_at IS NULL AND g.expires_at > now()))`, tokenHash).
		Scan(&se.ID, &se.User.ID, &se.User.Email, &se.User.FirstName, &se.User.LastName, &se.User.Phone,
			&se.User.EmailVerified, &se.User.LastLoginAt, &se.User.CreatedAt, &se.TenantID, &se.OrgName, &se.Role,
			&grants, &se.ExpiresAt, &lastSeen, &se.User.AccessUntil, &visitorName)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	se.Grants = parseGrants(grants)
	if se.User.AccessUntil != nil { // demo visitor: read-only, whatever viewers were granted
		se.User.IsGuest = true
		se.Grants = auth.GuestGrants(se.Grants)
		se.User.VisitorName = visitorName
		if visitorName != nil && *visitorName != "" { // logged as "Sam (visitor)"
			se.User.FirstName, se.User.LastName = *visitorName, "(visitor)"
		}
	}
	if time.Until(se.ExpiresAt) < ttl/2 || time.Since(lastSeen) > time.Minute {
		newExp := se.ExpiresAt
		if time.Until(se.ExpiresAt) < ttl/2 {
			newExp = time.Now().Add(ttl)
		}
		if se.User.AccessUntil != nil && newExp.After(*se.User.AccessUntil) {
			newExp = *se.User.AccessUntil
		}
		if _, err := s.pool.Exec(ctx, `UPDATE sessions SET last_seen_at = now(), expires_at = $2 WHERE id = $1`,
			se.ID, newExp); err == nil {
			se.ExpiresAt = newExp
		}
	}
	return &se, nil
}

func parseGrants(raw []byte) map[string][]string {
	saved := map[string][]string{}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &saved)
	}
	return auth.Normalize(saved)
}

// SwitchOrg moves a session to another organization of the same user.
func (s *Store) SwitchOrg(ctx context.Context, sessionID, userID, tenantID string) error {
	return s.plain(ctx, func(tx pgx.Tx) error {
		var ok bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM memberships WHERE user_id = $1 AND tenant_id::text = $2)`,
			userID, tenantID).Scan(&ok); err != nil {
			return err
		}
		if !ok {
			return ErrNotMemberOfOrg
		}
		if _, err := tx.Exec(ctx, `UPDATE sessions SET tenant_id = $2 WHERE id = $1`, sessionID, tenantID); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `UPDATE users SET last_tenant_id = $2 WHERE id = $1`, userID, tenantID)
		return err
	})
}

// DeleteSession signs one browser out.
func (s *Store) DeleteSession(ctx context.Context, tokenHash string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM sessions WHERE token_hash = $1`, tokenHash)
	return err
}

// DeleteUserSessions signs a user out everywhere, except the session keepID ("" = all).
func (s *Store) DeleteUserSessions(ctx context.Context, userID, keepID string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM sessions WHERE user_id = $1 AND ($2 = '' OR id::text <> $2)`, userID, keepID)
	return err
}

// ---------- email links ----------

// CreateUserToken stores a one-time link token (replacing older unused ones of the same purpose).
func (s *Store) CreateUserToken(ctx context.Context, userID, purpose, tokenHash string, ttl time.Duration) error {
	return s.plain(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `DELETE FROM user_tokens WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL`,
			userID, purpose); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `INSERT INTO user_tokens (user_id, purpose, token_hash, expires_at)
			VALUES ($1, $2, $3, now() + $4::interval)`, userID, purpose, tokenHash,
			fmt.Sprintf("%d seconds", int(ttl.Seconds())))
		return err
	})
}

func useToken(ctx context.Context, tx pgx.Tx, purpose, tokenHash string) (string, error) {
	var userID string
	err := tx.QueryRow(ctx, `UPDATE user_tokens SET used_at = now()
		WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
		RETURNING user_id::text`, tokenHash, purpose).Scan(&userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrTokenInvalid
	}
	return userID, err
}

// VerifyEmail marks the address of the link's user as verified.
func (s *Store) VerifyEmail(ctx context.Context, tokenHash string) (string, error) {
	var userID string
	err := s.plain(ctx, func(tx pgx.Tx) error {
		var err error
		if userID, err = useToken(ctx, tx, "verify_email", tokenHash); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE users SET email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1`, userID)
		return err
	})
	return userID, err
}

// ResetPassword sets a new password from a reset link and signs the user out everywhere.
// Opening the link proves the address, so it also counts as verifying it.
func (s *Store) ResetPassword(ctx context.Context, tokenHash, pwHash string) (string, error) {
	var userID string
	err := s.plain(ctx, func(tx pgx.Tx) error {
		var err error
		if userID, err = useToken(ctx, tx, "reset_password", tokenHash); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `UPDATE users SET password_hash = $2, password_changed_at = now(), failed_logins = 0,
			locked_until = NULL, email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1`, userID, pwHash); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `DELETE FROM sessions WHERE user_id = $1`, userID)
		return err
	})
	return userID, err
}

// SetPassword changes a signed-in user's password.
func (s *Store) SetPassword(ctx context.Context, userID, pwHash string) error {
	_, err := s.pool.Exec(ctx, `UPDATE users SET password_hash = $2, password_changed_at = now() WHERE id = $1`, userID, pwHash)
	return err
}

// UpdateProfile changes a user's name and phone.
func (s *Store) UpdateProfile(ctx context.Context, userID, first, last string, phone *string) error {
	_, err := s.pool.Exec(ctx, `UPDATE users SET first_name = $2, last_name = $3, full_name = $2 || ' ' || $3, phone = $4
		WHERE id = $1`, userID, first, last, phone)
	return err
}

// ---------- members and invitations ----------

// Member is a user in the current organization.
type Member struct {
	User
	Role     string    `json:"role"`
	JoinedAt time.Time `json:"joined_at"`
}

// Members lists the current organization's members, admins first.
func (s *Store) Members(ctx context.Context) ([]Member, error) {
	out := []Member{}
	err := s.tx(ctx, func(tx pgx.Tx, tid string) error {
		rows, err := tx.Query(ctx, `SELECT `+userColumns+`, m.role, m.created_at FROM memberships m
			JOIN users u ON u.id = m.user_id WHERE m.tenant_id = $1 AND u.guest_link_id IS NULL
			ORDER BY array_position(ARRAY['admin','member','viewer'], m.role), lower(coalesce(u.first_name, u.email::text))`, tid)
		if err != nil {
			return err
		}
		out, err = pgx.CollectRows(rows, func(r pgx.CollectableRow) (Member, error) {
			var m Member
			err := scanUser(r, &m.User, &m.Role, &m.JoinedAt)
			return m, err
		})
		return err
	})
	return out, err
}

// Invitation is a pending (or past) invitation to the organization.
type Invitation struct {
	ID         string     `json:"id"`
	Email      string     `json:"email"`
	Role       string     `json:"role"`
	InvitedBy  *string    `json:"invited_by"`
	ExpiresAt  time.Time  `json:"expires_at"`
	AcceptedAt *time.Time `json:"accepted_at"`
	RevokedAt  *time.Time `json:"revoked_at"`
	CreatedAt  time.Time  `json:"created_at"`
	Status     string     `json:"status"` // pending | expired | accepted | revoked
}

const invitationColumns = `i.id::text, i.email::text, i.role,
	nullif(trim(coalesce(u.first_name, '') || ' ' || coalesce(u.last_name, '')), ''),
	i.expires_at, i.accepted_at, i.revoked_at, i.created_at,
	CASE WHEN i.accepted_at IS NOT NULL THEN 'accepted' WHEN i.revoked_at IS NOT NULL THEN 'revoked'
	     WHEN i.expires_at < now() THEN 'expired' ELSE 'pending' END`

func scanInvitation(r pgx.Row, i *Invitation) error {
	return r.Scan(&i.ID, &i.Email, &i.Role, &i.InvitedBy, &i.ExpiresAt, &i.AcceptedAt, &i.RevokedAt, &i.CreatedAt, &i.Status)
}

// Invitations lists the organization's invitations that weren't accepted (newest first).
func (s *Store) Invitations(ctx context.Context) ([]Invitation, error) {
	out := []Invitation{}
	err := s.tx(ctx, func(tx pgx.Tx, tid string) error {
		rows, err := tx.Query(ctx, `SELECT `+invitationColumns+` FROM invitations i
			LEFT JOIN users u ON u.id = i.invited_by
			WHERE i.tenant_id = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL
			ORDER BY i.created_at DESC LIMIT 200`, tid)
		if err != nil {
			return err
		}
		out, err = pgx.CollectRows(rows, func(r pgx.CollectableRow) (Invitation, error) {
			var i Invitation
			return i, scanInvitation(r, &i)
		})
		return err
	})
	return out, err
}

// CreateInvitation invites an email to the organization with a role. An older pending
// invitation for the same email is replaced.
func (s *Store) CreateInvitation(ctx context.Context, email, role, tokenHash, actor string, ttl time.Duration) (*Invitation, error) {
	var out Invitation
	err := s.tx(ctx, func(tx pgx.Tx, tid string) error {
		var member bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id
			WHERE m.tenant_id = $1 AND u.email = $2::citext)`, tid, email).Scan(&member); err != nil {
			return err
		}
		if member {
			return ErrAlreadyMember
		}
		if _, err := tx.Exec(ctx, `UPDATE invitations SET revoked_at = now() WHERE tenant_id = $1 AND email = $2::citext
			AND accepted_at IS NULL AND revoked_at IS NULL`, tid, email); err != nil {
			return err
		}
		if err := scanInvitation(tx.QueryRow(ctx, `WITH i AS (
				INSERT INTO invitations (tenant_id, email, role, token_hash, invited_by, expires_at)
				VALUES ($1, $2::citext, $3, $4, $5, now() + $6::interval) RETURNING *)
			SELECT `+invitationColumns+` FROM i LEFT JOIN users u ON u.id = i.invited_by`,
			tid, email, role, tokenHash, actorID(ctx), fmt.Sprintf("%d seconds", int(ttl.Seconds()))), &out); err != nil {
			return err
		}
		return audit(ctx, tx, tid, actor, "member.invited", "invitation", out.ID,
			map[string]any{"message": "Invited " + email + " as " + role, "email": email, "role": role})
	})
	return &out, err
}

// RenewInvitation gives a pending invitation a new link and expiry (for "Resend").
func (s *Store) RenewInvitation(ctx context.Context, id, tokenHash, actor string, ttl time.Duration) (*Invitation, error) {
	var out Invitation
	err := s.tx(ctx, func(tx pgx.Tx, tid string) error {
		err := scanInvitation(tx.QueryRow(ctx, `WITH i AS (
				UPDATE invitations SET token_hash = $3, expires_at = now() + $4::interval
				WHERE tenant_id = $1 AND id::text = $2 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING *)
			SELECT `+invitationColumns+` FROM i LEFT JOIN users u ON u.id = i.invited_by`,
			tid, id, tokenHash, fmt.Sprintf("%d seconds", int(ttl.Seconds()))), &out)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		return audit(ctx, tx, tid, actor, "member.invite_resent", "invitation", out.ID,
			map[string]any{"message": "Invitation resent to " + out.Email, "email": out.Email})
	})
	return &out, err
}

// RevokeInvitation cancels a pending invitation.
func (s *Store) RevokeInvitation(ctx context.Context, id, actor string) error {
	return s.tx(ctx, func(tx pgx.Tx, tid string) error {
		var email string
		err := tx.QueryRow(ctx, `UPDATE invitations SET revoked_at = now() WHERE tenant_id = $1 AND id::text = $2
			AND accepted_at IS NULL AND revoked_at IS NULL RETURNING email::text`, tid, id).Scan(&email)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		return audit(ctx, tx, tid, actor, "member.invite_revoked", "invitation", id,
			map[string]any{"message": "Invitation to " + email + " cancelled", "email": email})
	})
}

// InvitationInfo is what the invitation page shows before accepting.
type InvitationInfo struct {
	Email         string `json:"email"`
	Role          string `json:"role"`
	OrgName       string `json:"org_name"`
	InvitedBy     string `json:"invited_by"`
	AccountExists bool   `json:"account_exists"`
	tenantID      string
	id            string
}

// InvitationByToken looks up a pending, unexpired invitation.
func (s *Store) InvitationByToken(ctx context.Context, tokenHash string) (*InvitationInfo, error) {
	var in InvitationInfo
	err := s.pool.QueryRow(ctx, `SELECT i.id::text, i.tenant_id::text, i.email::text, i.role, t.name,
		  coalesce(nullif(trim(coalesce(u.first_name, '') || ' ' || coalesce(u.last_name, '')), ''), 'An admin'),
		  EXISTS (SELECT 1 FROM users x WHERE x.email = i.email)
		FROM invitations i JOIN tenants t ON t.id = i.tenant_id LEFT JOIN users u ON u.id = i.invited_by
		WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()`, tokenHash).
		Scan(&in.id, &in.tenantID, &in.Email, &in.Role, &in.OrgName, &in.InvitedBy, &in.AccountExists)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrTokenInvalid
	}
	return &in, err
}

// AcceptInvitation adds the invited person to the organization. For a new person it
// creates the account (newUser set; the invitation link proves the email, so it is
// verified); for an existing account existingUserID is the user who signed in.
func (s *Store) AcceptInvitation(ctx context.Context, tokenHash string, first, last, pwHash, existingUserID string) (userID, tenantID string, err error) {
	err = s.plain(ctx, func(tx pgx.Tx) error {
		var invID, email, role string
		var invitedBy *string
		err := tx.QueryRow(ctx, `UPDATE invitations SET accepted_at = now()
			WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
			RETURNING id::text, tenant_id::text, email::text, role, invited_by::text`, tokenHash).
			Scan(&invID, &tenantID, &email, &role, &invitedBy)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrTokenInvalid
		}
		if err != nil {
			return err
		}
		name := strings.TrimSpace(first + " " + last)
		if existingUserID != "" {
			var match bool
			if err := tx.QueryRow(ctx, `SELECT email = $2::citext FROM users WHERE id = $1`, existingUserID, email).Scan(&match); err != nil {
				return err
			}
			if !match {
				return ErrTokenInvalid
			}
			userID = existingUserID
			if _, err := tx.Exec(ctx, `UPDATE users SET email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1`, userID); err != nil {
				return err
			}
		} else {
			err := tx.QueryRow(ctx, `INSERT INTO users (email, password_hash, first_name, last_name, full_name,
				email_verified_at, password_changed_at) VALUES ($1::citext, $2, $3, $4, $5, now(), now()) RETURNING id::text`,
				email, pwHash, first, last, name).Scan(&userID)
			if isUnique(err, "users_email_key") {
				return ErrEmailTaken
			}
			if err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, `INSERT INTO memberships (tenant_id, user_id, role, invited_by) VALUES ($1, $2, $3, $4)
			ON CONFLICT (tenant_id, user_id) DO NOTHING`, tenantID, userID, role, invitedBy); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE users SET last_tenant_id = $2 WHERE id = $1`, userID, tenantID); err != nil {
			return err
		}
		return auditTx(ctx, tx, tenantID, &userID, name, "member.joined", "user", userID,
			map[string]any{"message": email + " joined as " + role, "email": email, "role": role})
	})
	return userID, tenantID, err
}

// memberRole locks the organization's memberships and returns a user's role and the
// number of admins.
func memberRole(ctx context.Context, tx pgx.Tx, tid, userID string) (role, email string, admins int, err error) {
	if _, err = tx.Exec(ctx, `SELECT 1 FROM memberships WHERE tenant_id = $1 FOR UPDATE`, tid); err != nil {
		return
	}
	err = tx.QueryRow(ctx, `SELECT m.role, u.email::text,
		(SELECT count(*) FROM memberships WHERE tenant_id = $1 AND role = 'admin')
		FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = $1 AND m.user_id::text = $2`,
		tid, userID).Scan(&role, &email, &admins)
	if errors.Is(err, pgx.ErrNoRows) {
		err = ErrNotFound
	}
	return
}

// SetMemberRole changes a member's role. The last admin can't be demoted.
func (s *Store) SetMemberRole(ctx context.Context, userID, role, actor string) error {
	return s.tx(ctx, func(tx pgx.Tx, tid string) error {
		old, email, admins, err := memberRole(ctx, tx, tid, userID)
		if err != nil {
			return err
		}
		if old == role {
			return nil
		}
		if old == auth.RoleAdmin && admins <= 1 {
			return ErrLastAdmin
		}
		if _, err := tx.Exec(ctx, `UPDATE memberships SET role = $3 WHERE tenant_id = $1 AND user_id::text = $2`,
			tid, userID, role); err != nil {
			return err
		}
		return audit(ctx, tx, tid, actor, "member.role_changed", "user", userID, map[string]any{
			"message": fmt.Sprintf("%s: %s → %s", email, old, role), "email": email, "from": old, "to": role})
	})
}

// RemoveMember takes a user out of the organization and signs them out of it. The last
// admin can't be removed.
func (s *Store) RemoveMember(ctx context.Context, userID, actor string) error {
	return s.tx(ctx, func(tx pgx.Tx, tid string) error {
		role, email, admins, err := memberRole(ctx, tx, tid, userID)
		if err != nil {
			return err
		}
		if role == auth.RoleAdmin && admins <= 1 {
			return ErrLastAdmin
		}
		if _, err := tx.Exec(ctx, `DELETE FROM memberships WHERE tenant_id = $1 AND user_id::text = $2`, tid, userID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM sessions WHERE tenant_id = $1 AND user_id::text = $2`, tid, userID); err != nil {
			return err
		}
		// Someone in no other organization has no use for the account: it is deleted, so an
		// invitation later means signing up again (new password). Their past actions keep
		// their name in the activity log.
		msg := email + " removed from the organization"
		tag, err := tx.Exec(ctx, `DELETE FROM users WHERE id::text = $1 AND guest_link_id IS NULL
			AND NOT EXISTS (SELECT 1 FROM memberships WHERE user_id::text = $1)`, userID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 1 {
			msg += " (account deleted: not in another organization)"
		}
		return audit(ctx, tx, tid, actor, "member.removed", "user", userID,
			map[string]any{"message": msg, "email": email, "role": role})
	})
}

// RoleGrants returns what members and viewers may do in the current organization.
func (s *Store) RoleGrants(ctx context.Context) (map[string][]string, error) {
	var raw []byte
	err := s.tx(ctx, func(tx pgx.Tx, tid string) error {
		return tx.QueryRow(ctx, `SELECT role_permissions FROM tenants WHERE id = $1`, tid).Scan(&raw)
	})
	if err != nil {
		return nil, err
	}
	return parseGrants(raw), nil
}

// SetRoleGrants saves what members and viewers may do.
func (s *Store) SetRoleGrants(ctx context.Context, grants map[string][]string, actor string) error {
	grants = auth.Normalize(grants)
	return s.tx(ctx, func(tx pgx.Tx, tid string) error {
		var before []byte
		if err := tx.QueryRow(ctx, `SELECT role_permissions FROM tenants WHERE id = $1 FOR UPDATE`, tid).Scan(&before); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE tenants SET role_permissions = $2 WHERE id = $1`, tid, grants); err != nil {
			return err
		}
		return audit(ctx, tx, tid, actor, "roles.changed", "settings", "", map[string]any{
			"message": "Role permissions changed", "before": parseGrants(before), "after": grants})
	})
}

// ---------- organization profile ----------

// OrgProfile is the organization's details, used in report headers.
type OrgProfile struct {
	Name          string `json:"name"`
	Slug          string `json:"slug"`
	LegalName     string `json:"legal_name"`
	Address       string `json:"address"`
	City          string `json:"city"`
	Province      string `json:"province"`
	PostalCode    string `json:"postal_code"`
	Country       string `json:"country"`
	Phone         string `json:"phone"`
	WSIBFirmNo    string `json:"wsib_firm_number"`
	WSIBRateGroup string `json:"wsib_rate_group"`
	BusinessType  string `json:"business_type"`
	Establishment string `json:"establishment"` // OSHA establishment name
	// Days a deleted incident report can be restored (DefaultReportRetentionDays if unset).
	ReportRetentionDays int `json:"report_retention_days"`
}

// Org returns the current organization's profile.
func (s *Store) Org(ctx context.Context) (*OrgProfile, error) {
	var p OrgProfile
	err := s.tx(ctx, func(tx pgx.Tx, tid string) error {
		var raw []byte
		if err := tx.QueryRow(ctx, `SELECT name, slug::text, profile FROM tenants WHERE id = $1`, tid).Scan(&p.Name, &p.Slug, &raw); err != nil {
			return err
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return err
		}
		if p.ReportRetentionDays <= 0 {
			p.ReportRetentionDays = DefaultReportRetentionDays
		}
		return nil
	})
	return &p, err
}

// SetOrg saves the organization's name and profile.
func (s *Store) SetOrg(ctx context.Context, p OrgProfile, actor string) error {
	return s.tx(ctx, func(tx pgx.Tx, tid string) error {
		profile := map[string]any{
			"legal_name": p.LegalName, "address": p.Address, "city": p.City, "province": p.Province,
			"postal_code": p.PostalCode, "country": p.Country, "phone": p.Phone, "wsib_firm_number": p.WSIBFirmNo,
			"wsib_rate_group": p.WSIBRateGroup, "business_type": p.BusinessType, "establishment": p.Establishment,
			"report_retention_days": p.ReportRetentionDays,
		}
		if _, err := tx.Exec(ctx, `UPDATE tenants SET name = $2, profile = $3 WHERE id = $1`, tid, p.Name, profile); err != nil {
			return err
		}
		return audit(ctx, tx, tid, actor, "settings.org", "settings", "", map[string]any{
			"message": "Organization profile changed", "name": p.Name})
	})
}

// auditTx is audit with an explicit user ID (sign-up and invitations, before a session exists).
func auditTx(ctx context.Context, tx pgx.Tx, tid string, userID *string, actor, action, targetType, targetID string, details map[string]any) error {
	if userID != nil {
		ctx = WithActor(ctx, *userID)
	}
	if actor == "" {
		if err := tx.QueryRow(ctx, `SELECT coalesce(nullif(trim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')), ''), email::text)
			FROM users WHERE id = $1`, userID).Scan(&actor); err != nil {
			return err
		}
	}
	return audit(ctx, tx, tid, actor, action, targetType, targetID, details)
}
