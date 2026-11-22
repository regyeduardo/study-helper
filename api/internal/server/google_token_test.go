package server

import (
	"net/http"
	"testing"
	"time"
)

// "Usar a estrutura do app" com o Google já conectado no app: o app manda o token de acesso que já tem, o servidor confere com o
// Google que o token é DESTE app e de e-mail verificado, e abre a sessão sem pedir login de novo.

func TestGoogleTokenOpensSessionWithoutSigningInAgain(t *testing.T) {
	h := newHarness(t)
	h.google.grant("token-da-ana", map[string]any{"aud": clientID, "azp": clientID, "sub": "g-ana", "email": "Ana@Exemplo.com", "email_verified": "true", "expires_in": "3000"})
	browser := h.browser()
	response, body := h.do(browser, call{method: http.MethodPost, path: "/v1/auth/google/token", body: map[string]any{"accessToken": "token-da-ana"}})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("token = %d %v, want 200", response.StatusCode, body)
	}
	response, me := h.do(browser, call{path: "/v1/me"})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("me = %d, want 200 (a sessão abriu)", response.StatusCode)
	}
	user := me["user"].(map[string]any)
	if user["email"] != "ana@exemplo.com" || user["hasGoogle"] != true {
		t.Fatalf("user = %v", user)
	}
	// a mesma conta de sempre: entrar de novo pelo token não cria outra
	h.google.grant("outro-token-da-ana", map[string]any{"aud": clientID, "sub": "g-ana", "email": "ana@exemplo.com", "email_verified": "true", "expires_in": "3000"})
	h.do(h.browser(), call{method: http.MethodPost, path: "/v1/auth/google/token", body: map[string]any{"accessToken": "outro-token-da-ana"}})
	var accounts int
	_ = h.db.QueryRow(`SELECT COUNT(*) FROM user WHERE google_sub = 'g-ana'`).Scan(&accounts)
	if accounts != 1 {
		t.Fatalf("contas = %d, want 1", accounts)
	}
}

func TestGoogleTokenAdminComesFromTheVerifiedEmail(t *testing.T) {
	h := newHarness(t)
	h.google.grant("token-do-dono", map[string]any{"aud": clientID, "sub": "g-dono", "email": "dono@exemplo.com", "email_verified": "true", "expires_in": "3000"})
	browser := h.browser()
	h.do(browser, call{method: http.MethodPost, path: "/v1/auth/google/token", body: map[string]any{"accessToken": "token-do-dono"}})
	_, me := h.do(browser, call{path: "/v1/me"})
	if me["user"].(map[string]any)["admin"] != true {
		t.Fatalf("admin = %v, want true", me["user"])
	}
}

func TestGoogleTokenRefusals(t *testing.T) {
	h := newHarness(t)
	h.google.grant("de-outro-app", map[string]any{"aud": "outro-app.apps.googleusercontent.com", "azp": "outro-app.apps.googleusercontent.com", "sub": "g-x", "email": "x@exemplo.com", "email_verified": "true", "expires_in": "3000"})
	h.google.grant("sem-verificar", map[string]any{"aud": clientID, "sub": "g-y", "email": "y@exemplo.com", "email_verified": "false", "expires_in": "3000"})
	h.google.grant("vencido", map[string]any{"aud": clientID, "sub": "g-z", "email": "z@exemplo.com", "email_verified": "true", "expires_in": "0"})
	for _, token := range []string{"de-outro-app", "sem-verificar", "vencido", "que-o-google-nao-conhece", ""} {
		browser := h.browser()
		response, body := h.do(browser, call{method: http.MethodPost, path: "/v1/auth/google/token", body: map[string]any{"accessToken": token}})
		if response.StatusCode != http.StatusUnauthorized || body["error"] != "google_refused" {
			t.Errorf("%q = %d %v, want 401 google_refused", token, response.StatusCode, body)
		}
		if response, _ := h.do(browser, call{path: "/v1/me"}); response.StatusCode != http.StatusUnauthorized {
			t.Errorf("%q abriu sessão", token)
		}
	}
	// nenhuma conta criada pelas recusas
	var accounts int
	_ = h.db.QueryRow(`SELECT COUNT(*) FROM user`).Scan(&accounts)
	if accounts != 0 {
		t.Fatalf("contas = %d, want 0", accounts)
	}
	_ = time.Second
}

func TestGoogleTokenNeedsTheAppOrigin(t *testing.T) {
	h := newHarness(t)
	h.google.grant("token-da-ana", map[string]any{"aud": clientID, "sub": "g-ana", "email": "ana@exemplo.com", "email_verified": "true", "expires_in": "3000"})
	response, body := h.do(h.browser(), call{method: http.MethodPost, path: "/v1/auth/google/token", body: map[string]any{"accessToken": "token-da-ana"}, origin: "https://site-malicioso.test"})
	if response.StatusCode != http.StatusForbidden || body["error"] != "origin_refused" {
		t.Fatalf("origem estranha = %d %v, want 403 origin_refused", response.StatusCode, body)
	}
}

// O app e o servidor podem ter clientes Google diferentes no mesmo projeto: o token do app vale quando o cliente dele está na lista.
func TestGoogleTokenFromTheAppsOwnGoogleClient(t *testing.T) {
	h := newHarness(t)
	h.srv.cfg.Google.TokenAudiences = []string{"cliente-do-app.apps.googleusercontent.com"}
	h.google.grant("token-do-app", map[string]any{"aud": "cliente-do-app.apps.googleusercontent.com", "azp": "cliente-do-app.apps.googleusercontent.com", "sub": "g-ana", "email": "ana@exemplo.com", "email_verified": "true", "expires_in": "3000"})
	browser := h.browser()
	if response, body := h.do(browser, call{method: http.MethodPost, path: "/v1/auth/google/token", body: map[string]any{"accessToken": "token-do-app"}}); response.StatusCode != http.StatusOK {
		t.Fatalf("token do cliente do app = %d %v, want 200", response.StatusCode, body)
	}
}

// O token do Drive do app não traz e-mail nem id (só a permissão do Drive): o servidor pergunta ao Drive de quem é a conta.
func TestGoogleTokenWithOnlyDrivePermissionAsksDriveWhoItIs(t *testing.T) {
	h := newHarness(t)
	h.google.grant("token-so-drive", map[string]any{"aud": clientID, "azp": clientID, "expires_in": "2662", "_drive_email": "Dono@Exemplo.com"})
	browser := h.browser()
	if response, body := h.do(browser, call{method: http.MethodPost, path: "/v1/auth/google/token", body: map[string]any{"accessToken": "token-so-drive"}}); response.StatusCode != http.StatusOK {
		t.Fatalf("token só do Drive = %d %v, want 200", response.StatusCode, body)
	}
	_, me := h.do(browser, call{path: "/v1/me"})
	user := me["user"].(map[string]any)
	if user["email"] != "dono@exemplo.com" || user["admin"] != true {
		t.Fatalf("user = %v, want o dono, admin", user)
	}
	// o mesmo e-mail de novo: a mesma conta
	h.google.grant("outro-so-drive", map[string]any{"aud": clientID, "expires_in": "2662", "_drive_email": "dono@exemplo.com"})
	h.do(h.browser(), call{method: http.MethodPost, path: "/v1/auth/google/token", body: map[string]any{"accessToken": "outro-so-drive"}})
	var accounts int
	_ = h.db.QueryRow(`SELECT COUNT(*) FROM user`).Scan(&accounts)
	if accounts != 1 {
		t.Fatalf("contas = %d, want 1", accounts)
	}
}

// O dono (admin, e-mail verificado) não precisa de código para ligar a estrutura do app, mesmo com a exigência ligada.
func TestAdminTurnsTheStructureOnWithoutACode(t *testing.T) {
	h := newHarness(t)
	browser, id := h.account("no-code", false, "dono@exemplo.com")
	if _, err := h.db.Exec(`UPDATE user SET email_verified = 1 WHERE id = ?`, id); err != nil {
		t.Fatal(err)
	}
	_, me := h.do(browser, call{path: "/v1/me"})
	if me["requireCode"] != false {
		t.Fatalf("requireCode para o dono = %v, want false", me["requireCode"])
	}
	if response, body := h.do(browser, call{method: http.MethodPost, path: "/v1/structure", body: map[string]any{"on": true}}); response.StatusCode != http.StatusOK {
		t.Fatalf("ligar = %d %v, want 200", response.StatusCode, body)
	}
	_, me = h.do(browser, call{path: "/v1/me"})
	if user := me["user"].(map[string]any); user["appEnabled"] != true || user["status"] != "enabled" {
		t.Fatalf("user = %v", user)
	}
	// quem não é admin continua precisando do código
	other, _ := h.account("no-code", false, "ana@exemplo.com")
	if response, body := h.do(other, call{method: http.MethodPost, path: "/v1/structure", body: map[string]any{"on": true}}); response.StatusCode != http.StatusForbidden || body["error"] != "code_required" {
		t.Fatalf("outra conta = %d %v, want 403 code_required", response.StatusCode, body)
	}
}
