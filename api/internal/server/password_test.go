package server

import (
	"net/http"
	"strings"
	"testing"
)

// Sign-in with e-mail and password (FR-001, owner's decision of 2026-11-20).

func register(h *harness, client *http.Client, email, password string) (*http.Response, map[string]any) {
	return h.do(client, call{method: http.MethodPost, path: "/v1/auth/password/register", body: map[string]any{"email": email, "password": password, "name": "Ana Teste"}})
}

func login(h *harness, client *http.Client, email, password string) (*http.Response, map[string]any) {
	return h.do(client, call{method: http.MethodPost, path: "/v1/auth/password/login", body: map[string]any{"email": email, "password": password}})
}

func TestRegisterSignsInAndKeepsOnlyAHashOfThePassword(t *testing.T) {
	h := newHarness(t)
	client := h.browser()
	response, body := register(h, client, "  Ana@Exemplo.com ", "senha-forte-1")
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("register: %d %v", response.StatusCode, body)
	}
	_, me := h.do(client, call{path: "/v1/me"})
	user := me["user"].(map[string]any)
	if user["email"] != "ana@exemplo.com" || user["hasPassword"] != true || user["hasGoogle"] != false {
		t.Fatalf("me after register: %v", me)
	}
	var stored string
	_ = h.db.QueryRow(`SELECT password_hash FROM user WHERE email = 'ana@exemplo.com'`).Scan(&stored)
	if !strings.HasPrefix(stored, "$argon2id$") || strings.Contains(stored, "senha-forte-1") {
		t.Fatalf("stored password: %q", stored)
	}
	for _, cookie := range response.Cookies() {
		if cookie.Name == sessionCookie && (!cookie.HttpOnly || cookie.SameSite != http.SameSiteLaxMode) {
			t.Fatalf("session cookie must be HttpOnly and SameSite=Lax: %+v", cookie)
		}
	}
}

func TestRegisterRefusesATakenEmailAWeakPasswordAndABadEmail(t *testing.T) {
	h := newHarness(t)
	register(h, h.browser(), "ana@exemplo.com", "senha-forte-1")
	for name, c := range map[string]struct {
		email, password string
		status          int
		code            string
	}{
		"taken e-mail":   {"ANA@exemplo.com", "outra-senha-1", http.StatusConflict, "email_taken"},
		"short password": {"bruno@exemplo.com", "curta", http.StatusBadRequest, "weak_password"},
		"not an e-mail":  {"bruno.exemplo.com", "senha-forte-1", http.StatusBadRequest, "invalid_email"},
	} {
		if response, body := register(h, h.browser(), c.email, c.password); response.StatusCode != c.status || body["error"] != c.code {
			t.Errorf("%s: %d %v, want %d %s", name, response.StatusCode, body, c.status, c.code)
		}
	}
}

func TestLoginWithTheRightPasswordWrongPasswordAndUnknownEmail(t *testing.T) {
	h := newHarness(t)
	register(h, h.browser(), "ana@exemplo.com", "senha-forte-1")
	wrong, wrongBody := login(h, h.browser(), "ana@exemplo.com", "senha-errada")
	unknown, unknownBody := login(h, h.browser(), "ninguem@exemplo.com", "senha-forte-1")
	// the same answer: nobody learns which e-mails have an account
	if wrong.StatusCode != http.StatusUnauthorized || wrongBody["error"] != "wrong_credentials" || unknown.StatusCode != wrong.StatusCode || unknownBody["error"] != wrongBody["error"] {
		t.Fatalf("wrong: %d %v; unknown: %d %v", wrong.StatusCode, wrongBody, unknown.StatusCode, unknownBody)
	}
	client := h.browser()
	if response, body := login(h, client, "ANA@exemplo.com", "senha-forte-1"); response.StatusCode != http.StatusOK {
		t.Fatalf("right password: %d %v", response.StatusCode, body)
	}
	if response, _ := h.do(client, call{path: "/v1/me"}); response.StatusCode != http.StatusOK {
		t.Fatal("no session after login")
	}
}

func TestTenWrongPasswordsBlockForAWhileAndTheRightOneThenWaits(t *testing.T) {
	h := newHarness(t)
	register(h, h.browser(), "ana@exemplo.com", "senha-forte-1")
	for range 10 {
		login(h, h.browser(), "ana@exemplo.com", "senha-errada")
	}
	response, body := login(h, h.browser(), "ana@exemplo.com", "senha-forte-1")
	if response.StatusCode != http.StatusTooManyRequests || body["error"] != "too_many_attempts" || body["retryAfter"] == nil {
		t.Fatalf("after 10 wrong: %d %v, want 429 too_many_attempts", response.StatusCode, body)
	}
}

func TestARightPasswordClearsTheWrongOnes(t *testing.T) {
	h := newHarness(t)
	register(h, h.browser(), "ana@exemplo.com", "senha-forte-1")
	for range 9 {
		login(h, h.browser(), "ana@exemplo.com", "senha-errada")
	}
	login(h, h.browser(), "ana@exemplo.com", "senha-forte-1")
	for range 9 {
		login(h, h.browser(), "ana@exemplo.com", "senha-errada")
	}
	if response, _ := login(h, h.browser(), "ana@exemplo.com", "senha-forte-1"); response.StatusCode != http.StatusOK {
		t.Fatalf("the count did not start over: %d", response.StatusCode)
	}
}

func TestLogoutEndsTheSessionOfThisDeviceOnly(t *testing.T) {
	h := newHarness(t)
	register(h, h.browser(), "ana@exemplo.com", "senha-forte-1")
	laptop, phone := h.browser(), h.browser()
	login(h, laptop, "ana@exemplo.com", "senha-forte-1")
	login(h, phone, "ana@exemplo.com", "senha-forte-1")
	if response, body := h.do(laptop, call{method: http.MethodPost, path: "/v1/auth/logout"}); response.StatusCode != http.StatusOK || body["ok"] != true {
		t.Fatalf("logout: %d %v", response.StatusCode, body)
	}
	if response, _ := h.do(laptop, call{path: "/v1/me"}); response.StatusCode != http.StatusUnauthorized {
		t.Fatal("the laptop still has a session")
	}
	if response, _ := h.do(phone, call{path: "/v1/me"}); response.StatusCode != http.StatusOK {
		t.Fatal("the phone lost its session")
	}
}
