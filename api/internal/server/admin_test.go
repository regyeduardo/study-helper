package server

import (
	"net/http"
	"regexp"
	"testing"
	"time"
)

// Administration (FR-005 to FR-007, FR-058, SC-013, contracts/api-admin.md). The admin is the account whose e-mail is in ADMIN_EMAILS
// and was verified (by Google); for any other account every admin route is a route that does not exist.

// admin gives a browser of the administration account with its e-mail verified.
func (h *harness) admin() (*http.Client, string) {
	h.t.Helper()
	client, id := h.account("no-code", false, "dono@exemplo.com")
	if _, err := h.db.Exec(`UPDATE user SET email_verified = 1 WHERE id = ?`, id); err != nil {
		h.t.Fatal(err)
	}
	return client, id
}

var adminCalls = []call{
	{path: "/v1/admin/codes"},
	{method: http.MethodPost, path: "/v1/admin/codes", body: map[string]any{}},
	{method: http.MethodPost, path: "/v1/admin/codes/qualquer/cancel"},
	{path: "/v1/admin/accounts"},
	{method: http.MethodPost, path: "/v1/admin/accounts/qualquer/revoke"},
	{path: "/v1/admin/settings"},
	{method: http.MethodPut, path: "/v1/admin/settings", body: map[string]any{"requireCode": false}},
}

func TestAnyOtherAccountSeesNoAdminAndNothingHappens(t *testing.T) {
	h := newHarness(t)
	other, _ := h.account("enabled", true, "ana@exemplo.com")
	// the admin e-mail typed in a password account, never verified, is not the admin
	unverified := h.browser()
	register(h, unverified, "dono@exemplo.com", "senha-forte-1")
	for name, client := range map[string]*http.Client{"other account": other, "unverified admin e-mail": unverified, "no session": h.browser()} {
		for _, c := range adminCalls {
			response, body := h.do(client, c)
			// even without a session: the same answer as a route that does not exist
			if response.StatusCode != http.StatusNotFound || body["error"] != "not_found" {
				t.Errorf("%s %s %s: %d %v", name, c.method, c.path, response.StatusCode, body)
			}
		}
	}
	var codes int
	var required string
	_ = h.db.QueryRow(`SELECT COUNT(*) FROM promo_codes`).Scan(&codes)
	_ = h.db.QueryRow(`SELECT value FROM app_settings WHERE key = 'require_code'`).Scan(&required)
	if codes != 0 || required != "1" {
		t.Fatalf("something happened: %d codes, require_code %s", codes, required)
	}
	_, me := h.do(unverified, call{path: "/v1/me"})
	if me["user"].(map[string]any)["admin"] != false {
		t.Fatalf("unverified e-mail is admin in me: %v", me)
	}
}

func TestTheAdminMakesACodeWithTheDefaultsListsItAndCancelsIt(t *testing.T) {
	h := newHarness(t)
	admin, _ := h.admin()
	response, body := h.do(admin, call{method: http.MethodPost, path: "/v1/admin/codes", body: map[string]any{"madeFor": "Turma de inglês"}})
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("create: %d %v", response.StatusCode, body)
	}
	code, _ := body["code"].(string)
	if !regexp.MustCompile(`^[A-HJ-NP-Z2-9]{12}$`).MatchString(code) || body["maxUses"] != float64(1) || body["uses"] != float64(0) || body["status"] != "active" || body["madeFor"] != "Turma de inglês" {
		t.Fatalf("created: %v", body)
	}
	until, err := time.Parse(time.RFC3339Nano, body["validUntil"].(string))
	if err != nil || until.Sub(time.Now()) < 29*24*time.Hour || until.Sub(time.Now()) > 31*24*time.Hour {
		t.Fatalf("validUntil %v (%v), want about 30 days", body["validUntil"], err)
	}
	// someone uses it: the list shows who
	ana, _ := h.account("no-code", false, "ana@exemplo.com")
	useCode(h, ana, code)
	_, list := h.do(admin, call{path: "/v1/admin/codes"})
	codes := list["codes"].([]any)
	first := codes[0].(map[string]any)
	accounts := first["accounts"].([]any)
	if len(codes) != 1 || first["status"] != "used-up" || len(accounts) != 1 || accounts[0].(map[string]any)["email"] != "ana@exemplo.com" || accounts[0].(map[string]any)["usedAt"] == nil {
		t.Fatalf("list: %v", list)
	}
	// a second one for 3 people, canceled: the accounts already freed stay freed
	_, second := h.do(admin, call{method: http.MethodPost, path: "/v1/admin/codes", body: map[string]any{"maxUses": 3, "validUntil": time.Now().Add(72 * time.Hour).UTC().Format(time.RFC3339)}})
	if response, body := h.do(admin, call{method: http.MethodPost, path: "/v1/admin/codes/" + second["id"].(string) + "/cancel"}); response.StatusCode != http.StatusOK {
		t.Fatalf("cancel: %d %v", response.StatusCode, body)
	}
	bia, _ := h.account("no-code", false, "bia@exemplo.com")
	if response, body := useCode(h, bia, second["code"].(string)); response.StatusCode != http.StatusGone || body["error"] != "code_canceled" {
		t.Fatalf("use canceled: %d %v", response.StatusCode, body)
	}
	if response, body := h.do(admin, call{method: http.MethodPost, path: "/v1/admin/codes/nao-existe/cancel"}); response.StatusCode != http.StatusNotFound {
		t.Fatalf("cancel unknown: %d %v", response.StatusCode, body)
	}
	for name, bad := range map[string]map[string]any{"zero uses": {"maxUses": 0}, "past date": {"validUntil": "2000-01-01T00:00:00Z"}, "not a date": {"validUntil": "amanhã"}} {
		if response, body := h.do(admin, call{method: http.MethodPost, path: "/v1/admin/codes", body: bad}); response.StatusCode != http.StatusBadRequest {
			t.Errorf("%s: %d %v", name, response.StatusCode, body)
		}
	}
}

func TestTheAdminSeesTheAccountsAndRevokesOne(t *testing.T) {
	h := newHarness(t)
	admin, adminID := h.admin()
	h.promo("CODIGODAANA1", 1, 24*time.Hour, false)
	ana, anaID := h.account("no-code", false, "ana@exemplo.com")
	useCode(h, ana, "CODIGODAANA1")
	_, body := h.do(admin, call{path: "/v1/admin/accounts"})
	var row map[string]any
	for _, raw := range body["accounts"].([]any) {
		if account := raw.(map[string]any); account["id"] == anaID {
			row = account
		}
	}
	if row == nil || row["email"] != "ana@exemplo.com" || row["status"] != "enabled" || row["appEnabled"] != true || row["enabledAt"] == nil || row["code"] != "CODIGODAANA1" || row["seenAt"] == nil {
		t.Fatalf("accounts: %v", body)
	}
	if space := row["space"].(map[string]any); space["limit"] != float64(10<<30) {
		t.Fatalf("space: %v", space)
	}
	response, body := h.do(admin, call{method: http.MethodPost, path: "/v1/admin/accounts/" + anaID + "/revoke"})
	deleteAt, err := time.Parse(time.RFC3339Nano, stringOf(body["deleteAt"]))
	if response.StatusCode != http.StatusOK || err != nil || deleteAt.Sub(time.Now()) < 29*24*time.Hour {
		t.Fatalf("revoke: %d %v", response.StatusCode, body)
	}
	if response, body := structure(h, ana, true); response.StatusCode != http.StatusForbidden || body["error"] != "access_revoked" {
		t.Fatalf("revoked account: %d %v", response.StatusCode, body)
	}
	if response, body := h.do(admin, call{method: http.MethodPost, path: "/v1/admin/accounts/" + adminID + "/revoke"}); response.StatusCode != http.StatusConflict || body["error"] != "cannot_revoke_self" {
		t.Fatalf("revoke self: %d %v", response.StatusCode, body)
	}
	if response, _ := h.do(admin, call{method: http.MethodPost, path: "/v1/admin/accounts/nao-existe/revoke"}); response.StatusCode != http.StatusNotFound {
		t.Fatalf("revoke unknown: %d", response.StatusCode)
	}
}

func TestTheAdminTurnsTheCodeRuleOff(t *testing.T) {
	h := newHarness(t)
	admin, _ := h.admin()
	if _, body := h.do(admin, call{path: "/v1/admin/settings"}); body["requireCode"] != true {
		t.Fatalf("settings: %v", body)
	}
	if response, body := h.do(admin, call{method: http.MethodPut, path: "/v1/admin/settings", body: map[string]any{"requireCode": false}}); response.StatusCode != http.StatusOK || body["requireCode"] != false {
		t.Fatalf("put: %d %v", response.StatusCode, body)
	}
	ana, _ := h.account("no-code", false, "ana@exemplo.com")
	if _, me := h.do(ana, call{path: "/v1/me"}); me["requireCode"] != false {
		t.Fatalf("me: %v", me)
	}
	if response, _ := structure(h, ana, true); response.StatusCode != http.StatusOK {
		t.Fatalf("on without code: %d", response.StatusCode)
	}
	if response, body := h.do(admin, call{method: http.MethodPut, path: "/v1/admin/settings", body: map[string]any{"requireCode": "não"}}); response.StatusCode != http.StatusBadRequest {
		t.Fatalf("bad body: %d %v", response.StatusCode, body)
	}
}

func stringOf(value any) string {
	text, _ := value.(string)
	return text
}
