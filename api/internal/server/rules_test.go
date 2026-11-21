package server

import (
	"net/http"
	"testing"
)

// The common rules of the whole API (spec 003, contracts, "Regras comuns").

func TestWithoutSessionTheAnswerIs401WithTheCodeOnly(t *testing.T) {
	h := newHarness(t)
	response, body := h.do(h.browser(), call{path: "/v1/me"})
	if response.StatusCode != http.StatusUnauthorized || body["error"] != "no_session" || len(body) != 1 {
		t.Fatalf("got %d %v, want 401 {error: no_session}", response.StatusCode, body)
	}
}

func TestAnExpiredOrSignedOutDeviceIsNoSession(t *testing.T) {
	h := newHarness(t)
	client, userID := h.account("no-code", false, "ana@exemplo.com")
	if _, err := h.db.Exec(`UPDATE devices SET expires_at = '2000-01-01T00:00:00Z' WHERE user_id = ?`, userID); err != nil {
		t.Fatal(err)
	}
	if response, _ := h.do(client, call{path: "/v1/me"}); response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expired device: %d, want 401", response.StatusCode)
	}
}

func TestAChangeComesOnlyFromTheApp(t *testing.T) {
	h := newHarness(t)
	client, _ := h.account("no-code", false, "ana@exemplo.com")
	for name, c := range map[string]call{
		"without X-Estudo":       {method: http.MethodPost, path: "/v1/auth/logout", noMark: true},
		"from another site":      {method: http.MethodPost, path: "/v1/auth/logout", origin: "https://site-malicioso.test"},
		"without Origin at all":  {method: http.MethodPost, path: "/v1/auth/logout", origin: "-"},
		"a login from elsewhere": {method: http.MethodPost, path: "/v1/auth/password/login", origin: "https://site-malicioso.test", body: map[string]any{"email": "ana@exemplo.com", "password": "x"}},
	} {
		if response, body := h.do(client, c); response.StatusCode != http.StatusForbidden || body["error"] != "origin_refused" {
			t.Errorf("%s: %d %v, want 403 origin_refused", name, response.StatusCode, body)
		}
	}
}

func TestARevokedAccountReachesOnlyItsMe(t *testing.T) {
	h := newHarness(t)
	client, _ := h.account("revoked", false, "ana@exemplo.com")
	response, body := h.do(client, call{path: "/v1/me"})
	if response.StatusCode != http.StatusOK || body["user"].(map[string]any)["deleteAt"] == nil {
		t.Fatalf("me: %d %v", response.StatusCode, body)
	}
	// the app routes refuse it with the date everything will be deleted
	mux := http.NewServeMux()
	mux.Handle("GET /v1/library", h.srv.rules(appOn, false, func(w http.ResponseWriter, _ *http.Request, _ *Session) {
		writeJSON(w, 200, map[string]any{"ok": true})
	}))
	h.api.Config.Handler = mux
	response, body = h.do(client, call{path: "/v1/library"})
	if response.StatusCode != http.StatusForbidden || body["error"] != "access_revoked" || body["deleteAt"] == nil {
		t.Fatalf("library: %d %v, want 403 access_revoked with deleteAt", response.StatusCode, body)
	}
}

func TestTheAppRoutesNeedAFreedAccountWithTheStructureOn(t *testing.T) {
	h := newHarness(t)
	mux := http.NewServeMux()
	mux.Handle("GET /v1/library", h.srv.rules(appOn, false, func(w http.ResponseWriter, _ *http.Request, _ *Session) {
		writeJSON(w, 200, map[string]any{"ok": true})
	}))
	h.api.Config.Handler = mux
	noCode, _ := h.account("no-code", false, "a@exemplo.com")
	off, _ := h.account("enabled", false, "b@exemplo.com")
	on, _ := h.account("enabled", true, "c@exemplo.com")
	for name, client := range map[string]*http.Client{"no code": noCode, "structure off": off} {
		if response, body := h.do(client, call{path: "/v1/library"}); response.StatusCode != http.StatusForbidden || body["error"] != "app_disabled" {
			t.Errorf("%s: %d %v, want 403 app_disabled", name, response.StatusCode, body)
		}
	}
	if response, _ := h.do(on, call{path: "/v1/library"}); response.StatusCode != http.StatusOK {
		t.Fatalf("structure on: %d, want 200", response.StatusCode)
	}
}

func TestEveryJSONAnswerIsNeverCached(t *testing.T) {
	h := newHarness(t)
	client, _ := h.account("no-code", false, "ana@exemplo.com")
	for _, c := range []call{{path: "/v1/me"}, {path: "/v1/nothing-here"}} {
		response, _ := h.do(client, c)
		if response.Header.Get("Cache-Control") != "no-store" {
			t.Errorf("%s: Cache-Control %q", c.path, response.Header.Get("Cache-Control"))
		}
	}
	if response, body := h.do(h.browser(), call{path: "/v1/nothing-here"}); response.StatusCode != http.StatusNotFound || body["error"] != "not_found" {
		t.Fatalf("unknown route: %d %v", response.StatusCode, body)
	}
}

func TestOnlyTheAppMayCallWithItsCookie(t *testing.T) {
	h := newHarness(t)
	request, _ := http.NewRequest(http.MethodOptions, h.api.URL+"/v1/auth/logout", nil)
	request.Header.Set("Origin", appOrigin)
	request.Header.Set("Access-Control-Request-Method", "POST")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusNoContent || response.Header.Get("Access-Control-Allow-Origin") != appOrigin || response.Header.Get("Access-Control-Allow-Credentials") != "true" {
		t.Fatalf("preflight from the app: %d %v", response.StatusCode, response.Header)
	}
	request.Header.Set("Origin", "https://site-malicioso.test")
	response, _ = http.DefaultClient.Do(request)
	if response.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("another site got CORS")
	}
}

func TestMeSaysTheAccountTheCodeRuleTheDeviceAndTheSpace(t *testing.T) {
	h := newHarness(t)
	client, id := h.account("no-code", false, "dono@exemplo.com")
	_, body := h.do(client, call{path: "/v1/me"})
	user := body["user"].(map[string]any)
	if user["id"] != id || user["status"] != "no-code" || user["appEnabled"] != false || user["admin"] != true {
		t.Fatalf("user = %v", user)
	}
	if body["requireCode"] != true || body["device"].(map[string]any)["name"] != "Chrome no Linux" || body["space"].(map[string]any)["limit"] != float64(10<<30) {
		t.Fatalf("me = %v", body)
	}
}

func TestHealthIsPublicAndSaysTheVersion(t *testing.T) {
	h := newHarness(t)
	response, body := h.do(h.browser(), call{path: "/v1/health"})
	if response.StatusCode != http.StatusOK || body["ok"] != true || body["version"] != "teste" {
		t.Fatalf("health: %d %v", response.StatusCode, body)
	}
}
