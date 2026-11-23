package server

import (
	"net/http"
	"strings"
	"testing"
)

// The app saves a note's content with `If-Match` / `If-None-Match` (never over a newer version) and reads the version back from `ETag`.
// Without them in the preflight the browser blocks every save of a note in the App and the app says "offline" (the first guest, 23/11).
func TestPreflightLetsTheAppSaveNotes(t *testing.T) {
	h := newHarness(t)
	ana, _ := h.account("enabled", true, "ana@exemplo.com")
	res, _ := h.raw(ana, http.MethodOptions, "/v1/library/items/n1/parts/content", nil, map[string]string{
		"Origin":                         appOrigin,
		"Access-Control-Request-Method":  "PUT",
		"Access-Control-Request-Headers": "content-type,if-none-match,x-estudo",
	})
	allowed := strings.ToLower(res.Header.Get("Access-Control-Allow-Headers"))
	for _, name := range []string{"content-type", "x-estudo", "if-match", "if-none-match"} {
		if !strings.Contains(allowed, name) {
			t.Fatalf("the preflight allows %s: %q", name, allowed)
		}
	}
}

func TestTheAppReadsTheVersionOfWhatItSaved(t *testing.T) {
	h := newHarness(t)
	ana, _ := h.account("enabled", true, "ana@exemplo.com")
	res, _ := h.raw(ana, http.MethodGet, "/v1/me", nil, map[string]string{"Origin": appOrigin})
	if !strings.Contains(strings.ToLower(res.Header.Get("Access-Control-Expose-Headers")), "etag") {
		t.Fatalf("the app's page reads ETag: %v", res.Header)
	}
}
