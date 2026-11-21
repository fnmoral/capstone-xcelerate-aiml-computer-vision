package auth

import (
	"slices"
	"testing"
)

func TestAdminCanDoEverything(t *testing.T) {
	// Even with saved grants that remove everything, admins keep every permission.
	grants := map[string][]string{RoleMember: {}, RoleViewer: {}}
	for _, p := range Catalog {
		if !Can(RoleAdmin, p.Key, grants) {
			t.Errorf("admin should be able to %s", p.Key)
		}
	}
}

func TestDefaultRoles(t *testing.T) {
	def := DefaultGrants()
	for _, p := range Catalog {
		if got := Can(RoleMember, p.Key, def); got == p.AdminOnly {
			t.Errorf("member %s = %v, want %v", p.Key, got, !p.AdminOnly)
		}
	}
	for _, write := range []string{ManageAlerts, ManageCameras, ManageDetection, ManageNotifications, ManageSettings, ManageMembers, ManageRoles, CreateReports} {
		if Can(RoleViewer, write, def) {
			t.Errorf("viewer should be read-only, but can %s", write)
		}
	}
	for _, read := range []string{ViewLive, ViewEvents, ViewReports, ViewLogs} {
		if !Can(RoleViewer, read, def) {
			t.Errorf("viewer should be able to %s", read)
		}
	}
}

func TestNormalizeDropsAdminOnlyAndUnknown(t *testing.T) {
	got := Normalize(map[string][]string{
		RoleMember: {ManageMembers, ManageRoles, "nope", ViewLive, ViewLive},
		RoleViewer: {ManageAlerts},
	})
	if !slices.Equal(got[RoleMember], []string{ViewLive}) {
		t.Errorf("member = %v, want only %s", got[RoleMember], ViewLive)
	}
	if !slices.Equal(got[RoleViewer], []string{ManageAlerts}) {
		t.Errorf("viewer = %v: an admin may grant viewers extra permissions", got[RoleViewer])
	}
	if Can(RoleMember, ManageMembers, got) {
		t.Error("members must never manage members")
	}
	if Can("nobody", ViewLive, got) {
		t.Error("unknown role must have no permissions")
	}
}

func TestNormalizeKeepsDefaultsForUnsavedRoles(t *testing.T) {
	got := Normalize(map[string][]string{RoleViewer: {}})
	if len(got[RoleMember]) != len(DefaultGrants()[RoleMember]) {
		t.Errorf("unsaved member grants should be the defaults, got %v", got[RoleMember])
	}
	if len(got[RoleViewer]) != 0 {
		t.Errorf("saved empty viewer grants should stay empty, got %v", got[RoleViewer])
	}
}

func TestCheckPassword(t *testing.T) {
	for pw, ok := range map[string]bool{
		"short1":                 false,
		"onlyletterslong":        false,
		"1234567890123":          false,
		"correct horse 9":        true,
		"Sup3rSecret!":           true,
		string(make([]byte, 80)): false,
	} {
		if err := CheckPassword(pw, "a@b.co"); (err == nil) != ok {
			t.Errorf("CheckPassword(%q) = %v, want ok=%v", pw, err, ok)
		}
	}
	if CheckPassword("me@example.com1", "me@example.com1") == nil {
		t.Error("password equal to the email should be refused")
	}
}

func TestPasswordHash(t *testing.T) {
	h, err := HashPassword("correct horse 9")
	if err != nil {
		t.Fatal(err)
	}
	if !PasswordMatches(h, "correct horse 9") || PasswordMatches(h, "wrong horse 9") {
		t.Error("hash comparison broken")
	}
	if PasswordMatches("dev-only-not-a-real-hash", "anything") {
		t.Error("placeholder hashes must never match")
	}
}

func TestNormalizeEmail(t *testing.T) {
	if got, err := NormalizeEmail("  Jane.Doe@Example.COM "); err != nil || got != "jane.doe@example.com" {
		t.Errorf("got %q, %v", got, err)
	}
	for _, bad := range []string{"", "jane", "jane@", "Jane <jane@x.com>", "jane@localhost"} {
		if _, err := NormalizeEmail(bad); err == nil {
			t.Errorf("%q should be refused", bad)
		}
	}
}

func TestTokens(t *testing.T) {
	a, ha, err := NewToken()
	if err != nil {
		t.Fatal(err)
	}
	b, _, _ := NewToken()
	if a == b || len(a) < 40 || HashToken(a) != ha || ha == a {
		t.Error("tokens must be random, long, and stored only as a hash")
	}
}

func TestCleanName(t *testing.T) {
	if got, err := CleanName("  Acme   Care  Homes ", "org", 50); err != nil || got != "Acme Care Homes" {
		t.Errorf("got %q, %v", got, err)
	}
	if _, err := CleanName("<script>", "org", 50); err == nil {
		t.Error("angle brackets should be refused")
	}
	if _, err := CleanName("   ", "org", 50); err == nil {
		t.Error("blank should be refused")
	}
}

func TestGuestGrantsAreReadOnly(t *testing.T) {
	// Even if an admin gave viewers write access, a demo visitor only gets to look.
	grants := map[string][]string{RoleViewer: {ViewLive, ViewEvents, ViewMembers, ManageAlerts, ManageCameras}}
	g := GuestGrants(grants)
	for _, p := range []string{ManageAlerts, ManageCameras, ViewMembers, ManageMembers} {
		if Can(RoleViewer, p, g) {
			t.Errorf("demo visitor must not have %s", p)
		}
	}
	if !Can(RoleViewer, ViewLive, g) || !Can(RoleViewer, ViewEvents, g) {
		t.Error("demo visitor should keep the view permissions viewers have")
	}
	if !slices.Equal(Normalize(grants)[RoleViewer], []string{ViewLive, ViewEvents, ViewMembers, ManageAlerts, ManageCameras}) {
		t.Error("GuestGrants must not change the organization's grants")
	}
}
