package server

import (
	"crypto/rand"
	"crypto/rsa"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

// Sign-in with Google done by the server (FR-001, FR-008), against a fake Google that signs real RS256 id_tokens.

func TestStartSendsToGoogleWithStatePKCEAndOfflineAccess(t *testing.T) {
	h := newHarness(t)
	_, google := h.start("/biblioteca/abc")
	checks := map[string]string{"client_id": clientID, "response_type": "code", "access_type": "offline", "code_challenge_method": "S256", "redirect_uri": h.api.URL + "/v1/auth/google/callback"}
	for key, want := range checks {
		if google.Get(key) != want {
			t.Errorf("%s = %q, want %q", key, google.Get(key), want)
		}
	}
	if google.Get("state") == "" || len(google.Get("code_challenge")) < 43 || !strings.Contains(google.Get("scope"), "openid") || !strings.Contains(google.Get("scope"), "email") {
		t.Fatalf("query: %v", google)
	}
}

func TestASuccessfulSignInMakesTheAccountKeepsTheRefreshTokenEncryptedAndGoesBack(t *testing.T) {
	h := newHarness(t)
	client, google := h.start("/biblioteca/abc")
	h.googleGives("codigo-1", google, claimsFor("google-sub-ana", "Ana@Exemplo.com"), "refresh-secreto", nil)
	response := h.finish(client, "code=codigo-1&state="+url.QueryEscape(google.Get("state")))
	if response.StatusCode != http.StatusFound || response.Header.Get("Location") != appOrigin+"/biblioteca/abc" {
		t.Fatalf("callback: %d to %q", response.StatusCode, response.Header.Get("Location"))
	}
	_, me := h.do(client, call{path: "/v1/me"})
	user, _ := me["user"].(map[string]any)
	if user == nil || user["email"] != "ana@exemplo.com" || user["hasGoogle"] != true || user["name"] != "Ana Souza" || user["status"] != "no-code" {
		t.Fatalf("me after Google: %v", me)
	}
	var sealed string
	_ = h.db.QueryRow(`SELECT refresh_token_encrypted FROM auth_google`).Scan(&sealed)
	if sealed == "" || strings.Contains(sealed, "refresh-secreto") {
		t.Fatalf("refresh token stored as %q", sealed)
	}
	if plain, err := h.srv.open(sealed); err != nil || plain != "refresh-secreto" {
		t.Fatalf("the stored token does not open back: %q %v", plain, err)
	}
}

func TestSigningInAgainFindsTheSameAccount(t *testing.T) {
	h := newHarness(t)
	for i, code := range []string{"codigo-1", "codigo-2"} {
		client, google := h.start("/")
		h.googleGives(code, google, claimsFor("google-sub-ana", "ana@exemplo.com"), "", nil)
		if response := h.finish(client, "code="+code+"&state="+url.QueryEscape(google.Get("state"))); response.StatusCode != http.StatusFound || strings.Contains(response.Header.Get("Location"), "login=") {
			t.Fatalf("sign-in %d went to %s", i+1, response.Header.Get("Location"))
		}
	}
	var users int
	_ = h.db.QueryRow(`SELECT COUNT(*) FROM user`).Scan(&users)
	if users != 1 {
		t.Fatalf("%d accounts, want 1", users)
	}
}

// Whoever typed that e-mail with a password never proved it was theirs: when Google proves it, the account joins Google, and that
// password and its devices stop working (otherwise someone could make an account with another person's e-mail beforehand and keep
// a way into it).
func TestGoogleJoinsAnEmailAndPasswordAccountWithTheSameEmailAndDropsTheUnprovenPassword(t *testing.T) {
	h := newHarness(t)
	early := h.browser()
	register(h, early, "ana@exemplo.com", "senha-forte-1")
	client, google := h.start("/")
	h.googleGives("codigo-1", google, claimsFor("google-sub-ana", "ana@exemplo.com"), "", nil)
	h.finish(client, "code=codigo-1&state="+url.QueryEscape(google.Get("state")))
	_, me := h.do(client, call{path: "/v1/me"})
	user := me["user"].(map[string]any)
	if user["hasPassword"] != false || user["hasGoogle"] != true {
		t.Fatalf("me: %v", me)
	}
	var users int
	_ = h.db.QueryRow(`SELECT COUNT(*) FROM user`).Scan(&users)
	if users != 1 {
		t.Fatalf("%d accounts, want 1", users)
	}
	if response, _ := login(h, h.browser(), "ana@exemplo.com", "senha-forte-1"); response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("the unproven password still signs in: %d", response.StatusCode)
	}
	if response, _ := h.do(early, call{path: "/v1/me"}); response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("the device signed in with the unproven password still works: %d", response.StatusCode)
	}
}

func TestTheWaysASignInFails(t *testing.T) {
	stranger, _ := rsa.GenerateKey(rand.Reader, 2048)
	expired := claimsFor("google-sub-ana", "ana@exemplo.com")
	expired["exp"] = time.Now().Add(-time.Hour).Unix()
	otherApp := claimsFor("google-sub-ana", "ana@exemplo.com")
	otherApp["aud"] = "outro-app.apps.googleusercontent.com"
	unverified := claimsFor("google-sub-ana", "ana@exemplo.com")
	unverified["email_verified"] = false
	otherIssuer := claimsFor("google-sub-ana", "ana@exemplo.com")
	otherIssuer["iss"] = "https://falso.test"
	for name, c := range map[string]struct {
		claims   map[string]any
		signWith *rsa.PrivateKey
	}{
		"a token signed by someone else": {claimsFor("google-sub-ana", "ana@exemplo.com"), stranger},
		"an expired token":               {expired, nil},
		"a token for another app":        {otherApp, nil},
		"an e-mail not verified":         {unverified, nil},
		"another issuer":                 {otherIssuer, nil},
	} {
		h := newHarness(t)
		client, google := h.start("/biblioteca")
		h.googleGives("codigo-1", google, c.claims, "", c.signWith)
		response := h.finish(client, "code=codigo-1&state="+url.QueryEscape(google.Get("state")))
		if response.Header.Get("Location") != appOrigin+"/biblioteca?login=failed" {
			t.Errorf("%s: went to %q, want ?login=failed", name, response.Header.Get("Location"))
		}
		var users int
		_ = h.db.QueryRow(`SELECT COUNT(*) FROM user`).Scan(&users)
		if users != 0 {
			t.Errorf("%s: an account was made", name)
		}
	}
}

func TestRefusedOnGoogleExpiredStateAndGoogleDown(t *testing.T) {
	h := newHarness(t)
	client, google := h.start("/biblioteca")
	if response := h.finish(client, "error=access_denied&state="+url.QueryEscape(google.Get("state"))); response.Header.Get("Location") != appOrigin+"/biblioteca?login=refused" {
		t.Errorf("refused: %q", response.Header.Get("Location"))
	}
	client, google = h.start("/biblioteca")
	if response := h.finish(client, "code=x&state=outro-estado"); response.Header.Get("Location") != appOrigin+"/?login=expired" {
		t.Errorf("another state: %q", response.Header.Get("Location"))
	}
	if response := h.finish(h.browser(), "code=x&state="+url.QueryEscape(google.Get("state"))); response.Header.Get("Location") != appOrigin+"/?login=expired" {
		t.Errorf("no sign-in cookie: %q", response.Header.Get("Location"))
	}
	client, google = h.start("/biblioteca")
	h.googleGives("codigo-1", google, claimsFor("google-sub-ana", "ana@exemplo.com"), "", nil)
	h.google.failNext = true
	if response := h.finish(client, "code=codigo-1&state="+url.QueryEscape(google.Get("state"))); response.Header.Get("Location") != appOrigin+"/biblioteca?login=failed" {
		t.Errorf("Google down: %q", response.Header.Get("Location"))
	}
}

func TestACodeWithAnotherVerifierIsRefused(t *testing.T) {
	h := newHarness(t)
	client, google := h.start("/")
	// Google bound this code to another start's challenge: the API's verifier does not match
	_, other := h.start("/")
	h.googleGives("codigo-1", other, claimsFor("google-sub-ana", "ana@exemplo.com"), "", nil)
	if response := h.finish(client, "code=codigo-1&state="+url.QueryEscape(google.Get("state"))); response.Header.Get("Location") != appOrigin+"/?login=failed" {
		t.Fatalf("went to %q", response.Header.Get("Location"))
	}
}

func TestReturnGoesOnlyToAPathOfTheApp(t *testing.T) {
	for given, want := range map[string]string{"/biblioteca": "/biblioteca", "//evil.test": "/", "https://evil.test": "/", "": "/", "/a\\b": "/"} {
		if got := safeReturn(given); got != want {
			t.Errorf("safeReturn(%q) = %q, want %q", given, got, want)
		}
	}
}
