package server

import (
	"net/http"
	"sync"
	"testing"
	"time"
)

// "Usar a estrutura do app" and the promo code (FR-002 to FR-010, contracts/api-conta.md).

// promo puts a code straight in the database; validUntil is relative to now.
func (h *harness) promo(code string, maxUses int, validFor time.Duration, canceled bool) string {
	h.t.Helper()
	id := newID()
	now := time.Now().UTC()
	var canceledAt any
	if canceled {
		canceledAt = stamp(now)
	}
	if _, err := h.db.Exec(`INSERT INTO promo_codes (id, code, max_uses, valid_until, canceled_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`, id, code, maxUses, stamp(now.Add(validFor)), canceledAt, stamp(now)); err != nil {
		h.t.Fatal(err)
	}
	return id
}

func useCode(h *harness, client *http.Client, code string) (*http.Response, map[string]any) {
	return h.do(client, call{method: http.MethodPost, path: "/v1/code/use", body: map[string]any{"code": code}})
}

func (h *harness) userRow(id string) (status string, appEnabled int, failures int) {
	h.t.Helper()
	if err := h.db.QueryRow(`SELECT status, app_enabled, code_failures FROM user WHERE id = ?`, id).Scan(&status, &appEnabled, &failures); err != nil {
		h.t.Fatal(err)
	}
	return
}

func TestAGoodCodeFreesTheAccountAndTurnsTheStructureOn(t *testing.T) {
	h := newHarness(t)
	codeID := h.promo("ABCDEFGHJKMN", 1, 24*time.Hour, false)
	client, id := h.account("no-code", false, "ana@exemplo.com")
	// typed in lower case, with spaces and dashes
	response, body := useCode(h, client, " abcd efgh-jkmn ")
	if response.StatusCode != http.StatusOK || body["status"] != "enabled" || body["alreadyEnabled"] != nil {
		t.Fatalf("use: %d %v", response.StatusCode, body)
	}
	if status, on, _ := h.userRow(id); status != "enabled" || on != 1 {
		t.Fatalf("account: %s %d", status, on)
	}
	var uses, used int
	_ = h.db.QueryRow(`SELECT uses FROM promo_codes WHERE id = ?`, codeID).Scan(&uses)
	_ = h.db.QueryRow(`SELECT COUNT(*) FROM promo_code_uses WHERE user_id = ? AND promo_code_id = ?`, id, codeID).Scan(&used)
	if uses != 1 || used != 1 {
		t.Fatalf("uses %d, use rows %d", uses, used)
	}
	// a freed account does not spend a code again
	h.promo("OUTROCODIGO2", 1, 24*time.Hour, false)
	response, body = useCode(h, client, "OUTROCODIGO2")
	if response.StatusCode != http.StatusOK || body["alreadyEnabled"] != true {
		t.Fatalf("again: %d %v", response.StatusCode, body)
	}
	_ = h.db.QueryRow(`SELECT uses FROM promo_codes WHERE code = 'OUTROCODIGO2'`).Scan(&uses)
	if uses != 0 {
		t.Fatalf("a freed account spent another code")
	}
}

func TestEachRefusalHasItsCodeInTheContractOrder(t *testing.T) {
	h := newHarness(t)
	h.promo("CANCELADO123", 5, 24*time.Hour, true)
	h.promo("VENCIDO12345", 5, -time.Hour, false)
	h.promo("ESGOTADO1234", 1, 24*time.Hour, false)
	h.db.Exec(`UPDATE promo_codes SET uses = 1 WHERE code = 'ESGOTADO1234'`)
	// canceled and expired: canceled wins
	h.promo("CANCELADOVEN", 5, -time.Hour, true)
	client, id := h.account("no-code", false, "ana@exemplo.com")
	for _, c := range []struct {
		code   string
		status int
		error  string
	}{
		{"NAOEXISTE999", http.StatusNotFound, "code_not_found"},
		{"CANCELADO123", http.StatusGone, "code_canceled"},
		{"CANCELADOVEN", http.StatusGone, "code_canceled"},
		{"VENCIDO12345", http.StatusGone, "code_expired"},
		{"ESGOTADO1234", http.StatusConflict, "code_used_up"},
	} {
		response, body := useCode(h, client, c.code)
		if response.StatusCode != c.status || body["error"] != c.error {
			t.Errorf("%s: %d %v, want %d %s", c.code, response.StatusCode, body, c.status, c.error)
		}
		if c.error == "code_expired" && body["expiredAt"] == nil {
			t.Errorf("expired without the date: %v", body)
		}
	}
	if status, on, failures := h.userRow(id); status != "no-code" || on != 0 || failures != 5 {
		t.Fatalf("account after 5 refusals: %s %d failures=%d", status, on, failures)
	}
}

func TestTenWrongCodesBlockForAnHourAndAGoodOneResetsTheCount(t *testing.T) {
	h := newHarness(t)
	h.promo("BOMCODIGO123", 1, 24*time.Hour, false)
	client, id := h.account("no-code", false, "ana@exemplo.com")
	for i := 0; i < 9; i++ {
		useCode(h, client, "ERRADO")
	}
	// the 10th refusal blocks; then even a good code is refused until the hour ends
	if response, body := useCode(h, client, "ERRADO"); response.StatusCode != http.StatusNotFound {
		t.Fatalf("10th: %d %v", response.StatusCode, body)
	}
	response, body := useCode(h, client, "BOMCODIGO123")
	if response.StatusCode != http.StatusTooManyRequests || body["error"] != "too_many_attempts" || body["retryAfter"] == nil {
		t.Fatalf("blocked: %d %v", response.StatusCode, body)
	}
	// an hour later the good code works and the count goes back to zero
	h.db.Exec(`UPDATE user SET code_blocked_until = ? WHERE id = ?`, stamp(time.Now().Add(-time.Minute)), id)
	useCode(h, client, "ERRADO")
	if response, body := useCode(h, client, "BOMCODIGO123"); response.StatusCode != http.StatusOK {
		t.Fatalf("after the hour: %d %v", response.StatusCode, body)
	}
	if _, _, failures := h.userRow(id); failures != 0 {
		t.Fatalf("failures after a good code: %d", failures)
	}
}

func TestTwoAccountsRacingForTheLastUseOneGetsItTheOtherHearsUsedUp(t *testing.T) {
	h := newHarness(t)
	h.promo("ULTIMOUSO123", 1, 24*time.Hour, false)
	a, _ := h.account("no-code", false, "a@exemplo.com")
	b, _ := h.account("no-code", false, "b@exemplo.com")
	statuses := make([]int, 2)
	var wait sync.WaitGroup
	for i, client := range []*http.Client{a, b} {
		wait.Add(1)
		go func(i int, client *http.Client) {
			defer wait.Done()
			response, _ := useCode(h, client, "ULTIMOUSO123")
			statuses[i] = response.StatusCode
		}(i, client)
	}
	wait.Wait()
	if !(statuses[0] == http.StatusOK && statuses[1] == http.StatusConflict) && !(statuses[0] == http.StatusConflict && statuses[1] == http.StatusOK) {
		t.Fatalf("statuses %v, want one 200 and one 409", statuses)
	}
	var uses int
	_ = h.db.QueryRow(`SELECT uses FROM promo_codes WHERE code = 'ULTIMOUSO123'`).Scan(&uses)
	if uses != 1 {
		t.Fatalf("uses = %d", uses)
	}
}

func structure(h *harness, client *http.Client, on any) (*http.Response, map[string]any) {
	return h.do(client, call{method: http.MethodPost, path: "/v1/structure", body: map[string]any{"on": on}})
}

func TestTurningTheStructureOnNeedsACodeWhileTheRuleIsOn(t *testing.T) {
	h := newHarness(t)
	client, id := h.account("no-code", false, "ana@exemplo.com")
	if response, body := structure(h, client, true); response.StatusCode != http.StatusForbidden || body["error"] != "code_required" {
		t.Fatalf("on without code: %d %v", response.StatusCode, body)
	}
	// with the rule off, turning it on frees the account
	h.db.Exec(`UPDATE app_settings SET value = '0' WHERE key = 'require_code'`)
	if response, body := structure(h, client, true); response.StatusCode != http.StatusOK || body["appEnabled"] != true {
		t.Fatalf("on with the rule off: %d %v", response.StatusCode, body)
	}
	if status, on, _ := h.userRow(id); status != "enabled" || on != 1 {
		t.Fatalf("account: %s %d", status, on)
	}
}

func TestTurningOffKeepsTheAccountFreedAndOnAgainNeedsNoCode(t *testing.T) {
	h := newHarness(t)
	client, id := h.account("enabled", true, "ana@exemplo.com")
	if response, body := structure(h, client, false); response.StatusCode != http.StatusOK || body["appEnabled"] != false {
		t.Fatalf("off: %d %v", response.StatusCode, body)
	}
	if status, on, _ := h.userRow(id); status != "enabled" || on != 0 {
		t.Fatalf("after off: %s %d", status, on)
	}
	if response, body := structure(h, client, true); response.StatusCode != http.StatusOK || body["appEnabled"] != true {
		t.Fatalf("on again: %d %v", response.StatusCode, body)
	}
	if response, body := structure(h, client, "sim"); response.StatusCode != http.StatusBadRequest || body["error"] != "invalid_body" {
		t.Fatalf("bad body: %d %v", response.StatusCode, body)
	}
}

func TestARevokedAccountCannotUseACodeNorTurnTheStructureOn(t *testing.T) {
	h := newHarness(t)
	h.promo("BOMCODIGO123", 1, 24*time.Hour, false)
	client, _ := h.account("revoked", false, "ana@exemplo.com")
	if response, body := useCode(h, client, "BOMCODIGO123"); response.StatusCode != http.StatusForbidden || body["error"] != "access_revoked" {
		t.Fatalf("code: %d %v", response.StatusCode, body)
	}
	if response, body := structure(h, client, true); response.StatusCode != http.StatusForbidden || body["error"] != "access_revoked" {
		t.Fatalf("structure: %d %v", response.StatusCode, body)
	}
}
