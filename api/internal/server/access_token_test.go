package server

import (
	"encoding/base64"
	"net/http"
	"net/url"
	"testing"
	"time"
)

// T210 (dono, 28/11: "JWT na autenticação"; FR-085): a short access token, signed, in each request, checked without the database; the
// renewal stays in the server and is refused when the access was taken away or the device signed out.

func accessOf(res *http.Response) string {
	for _, cookie := range res.Cookies() {
		if cookie.Name == accessCookie {
			return cookie.Value
		}
	}
	return ""
}

func TestARequestWithAValidAccessTokenDoesNotGoToTheDatabase(t *testing.T) {
	h := newHarness(t)
	ana, anaID := h.account("enabled", true, "ana@exemplo.com")
	res, _ := h.do(ana, call{path: "/v1/me"})
	if res.StatusCode != http.StatusOK || accessOf(res) == "" {
		t.Fatalf("me %d, token %q", res.StatusCode, accessOf(res))
	}
	// the session in the database no longer matches: the token alone signs the request in
	if _, err := h.db.Exec(`UPDATE devices SET session_hash = 'outra' WHERE user_id = ?`, anaID); err != nil {
		t.Fatal(err)
	}
	if res, _ := h.do(ana, call{path: "/v1/devices"}); res.StatusCode != http.StatusOK || accessOf(res) != "" {
		t.Fatalf("with the token: %d (renewed: %v)", res.StatusCode, accessOf(res) != "")
	}
	// past its 5 minutes, the token is renewed by the session, which the database refuses now
	h.now = h.now.Add(accessTTL + time.Second)
	if res, _ := h.do(ana, call{path: "/v1/devices"}); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expired: %d", res.StatusCode)
	}
}

func TestAnExpiredAccessTokenIsRenewedByTheSessionInTheSameRequest(t *testing.T) {
	h := newHarness(t)
	ana, _ := h.account("enabled", true, "ana@exemplo.com")
	res, _ := h.do(ana, call{path: "/v1/me"})
	first := accessOf(res)
	h.now = h.now.Add(accessTTL + time.Second)
	res, _ = h.do(ana, call{path: "/v1/devices"})
	if res.StatusCode != http.StatusOK || accessOf(res) == "" || accessOf(res) == first {
		t.Fatalf("renewal: %d, token %q", res.StatusCode, accessOf(res))
	}
}

func TestTakingTheAccessAwayOrSigningTheDeviceOutCountsAtOnce(t *testing.T) {
	h := newHarness(t)
	owner, ownerID := h.account("enabled", true, "dono@exemplo.com")
	if _, err := h.db.Exec(`UPDATE user SET email_verified = 1 WHERE id = ?`, ownerID); err != nil {
		t.Fatal(err)
	}
	ana, anaID := h.account("enabled", true, "ana@exemplo.com")
	if res, _ := h.do(ana, call{path: "/v1/library/index"}); accessOf(res) == "" {
		t.Fatalf("no token: %d", res.StatusCode)
	}
	if res, body := h.do(owner, call{method: http.MethodPost, path: "/v1/admin/accounts/" + anaID + "/revoke"}); res.StatusCode != http.StatusOK {
		t.Fatalf("revoke %d %v", res.StatusCode, body)
	}
	// within the 5 minutes of its token, the account taken away is refused already
	if res, body := h.do(ana, call{path: "/v1/devices"}); res.StatusCode != http.StatusForbidden || body["error"] != "access_revoked" {
		t.Fatalf("revoked: %d %v", res.StatusCode, body)
	}
	// the owner signs their own device out: the next request has nobody signed in
	_, me := h.do(owner, call{path: "/v1/me"})
	device, _ := me["device"].(map[string]any)
	if res, _ := h.do(owner, call{method: http.MethodDelete, path: "/v1/devices/" + device["id"].(string)}); res.StatusCode != http.StatusOK {
		t.Fatalf("sign out %d", res.StatusCode)
	}
	// the jar dropped the session cookie; the access token is sent again by hand, still within its 5 minutes
	kept := h.browser()
	target, _ := url.Parse(h.api.URL)
	kept.Jar.SetCookies(target, owner.Jar.Cookies(target))
	if res, _ := h.do(kept, call{path: "/v1/devices"}); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("signed out: %d", res.StatusCode)
	}
}

func TestATokenNotSignedHereIsNobody(t *testing.T) {
	h := newHarness(t)
	_, anaID := h.account("enabled", true, "ana@exemplo.com")
	forged := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none","typ":"JWT"}`)) + "." + base64.RawURLEncoding.EncodeToString([]byte(`{"sub":"`+anaID+`","st":"enabled","app":true,"exp":9999999999}`)) + "."
	other := newAccessTokens([]byte("outra chave do servidor, 32 bytes"))
	made := other.make(&Session{User: User{ID: anaID, Status: "enabled", AppEnabled: true}}, h.now)
	for _, token := range []string{forged, made, jwtHeader + ".e30.xxx"} {
		client := h.browser()
		target, _ := url.Parse(h.api.URL)
		client.Jar.SetCookies(target, []*http.Cookie{{Name: accessCookie, Value: token, Path: "/"}})
		if res, _ := h.do(client, call{path: "/v1/devices"}); res.StatusCode != http.StatusUnauthorized {
			t.Fatalf("%q: %d", token, res.StatusCode)
		}
	}
}
