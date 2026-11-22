package server

import (
	"net/http"
	"strings"
	"testing"
)

// Streaming (owner's "Sim, um streaming"): the player uses the media's address as `<video src crossorigin="use-credentials">`, so the
// browser asks for the media in parts (Range) with the session cookie, from the app's origin, and plays before it all arrives.

// storedMedia keeps "abcdefghij" as the video of note n1, the way the app sends it (in parts, then complete).
func storedMedia(t *testing.T, h *harness, client *http.Client) {
	t.Helper()
	h.do(client, call{method: http.MethodPut, path: "/v1/library/items/n1", body: map[string]any{"baseRev": 0, "row": row("Reunião", nil)}})
	_, body := h.do(client, call{method: http.MethodPost, path: "/v1/uploads", body: map[string]any{"item": "n1", "media": "m1", "name": "reuniao.webm", "mime": "video/webm", "bytes": 10}})
	upload, _ := body["upload"].(string)
	for n, part := range []string{"abcd", "efgh", "ij"} {
		h.raw(client, http.MethodPut, "/v1/uploads/"+upload+"/parts/"+itoa(n+1), []byte(part), nil)
	}
	if res, _ := h.do(client, call{method: http.MethodPost, path: "/v1/uploads/" + upload + "/complete"}); res.StatusCode != 200 {
		t.Fatalf("complete: %d", res.StatusCode)
	}
}

func TestMediaStreamsToThePlayer(t *testing.T) {
	h := newHarness(t)
	ana, _ := h.account("enabled", true, "ana@exemplo.com")
	storedMedia(t, h, ana)
	fromApp := func(extra map[string]string) map[string]string {
		headers := map[string]string{"Origin": appOrigin}
		for name, value := range extra {
			headers[name] = value
		}
		return headers
	}

	// the first ask of a <video>: "from the start", answered in part, readable by the app's page with the cookie
	res, out := h.raw(ana, http.MethodGet, "/v1/media/n1/m1", nil, fromApp(map[string]string{"Range": "bytes=0-"}))
	if res.StatusCode != 206 || string(out) != "abcdefghij" || res.Header.Get("Content-Range") != "bytes 0-9/10" || res.Header.Get("Content-Length") != "10" || res.Header.Get("Accept-Ranges") != "bytes" {
		t.Fatalf("from the start: %d %q %v", res.StatusCode, out, res.Header)
	}
	if res.Header.Get("Access-Control-Allow-Origin") != appOrigin || res.Header.Get("Access-Control-Allow-Credentials") != "true" || !strings.Contains(res.Header.Get("Vary"), "Origin") {
		t.Fatalf("CORS with credentials: %v", res.Header)
	}
	exposed := strings.ToLower(res.Header.Get("Access-Control-Expose-Headers"))
	for _, name := range []string{"content-range", "accept-ranges", "content-length"} {
		if !strings.Contains(exposed, name) {
			t.Fatalf("the app's page reads %s: %q", name, exposed)
		}
	}

	// a jump to the middle and Safari's first ask (the last bytes, then two bytes)
	for _, c := range []struct{ asked, body, span string }{{"bytes=4-100", "efghij", "bytes 4-9/10"}, {"bytes=-3", "hij", "bytes 7-9/10"}, {"bytes=0-1", "ab", "bytes 0-1/10"}} {
		res, out := h.raw(ana, http.MethodGet, "/v1/media/n1/m1", nil, fromApp(map[string]string{"Range": c.asked}))
		if res.StatusCode != 206 || string(out) != c.body || res.Header.Get("Content-Range") != c.span || res.Header.Get("Content-Length") != itoa(len(c.body)) {
			t.Fatalf("%s: %d %q %v", c.asked, res.StatusCode, out, res.Header)
		}
	}

	// HEAD says the size and that parts are taken, without the bytes
	res, out = h.raw(ana, http.MethodHead, "/v1/media/n1/m1", nil, fromApp(nil))
	if res.StatusCode != 200 || len(out) != 0 || res.Header.Get("Content-Length") != "10" || res.Header.Get("Accept-Ranges") != "bytes" || res.Header.Get("Content-Type") != "video/webm" {
		t.Fatalf("HEAD: %d %q %v", res.StatusCode, out, res.Header)
	}
	res, out = h.raw(ana, http.MethodHead, "/v1/media/n1/m1", nil, fromApp(map[string]string{"Range": "bytes=2-3"}))
	if res.StatusCode != 206 || len(out) != 0 || res.Header.Get("Content-Range") != "bytes 2-3/10" || res.Header.Get("Content-Length") != "2" {
		t.Fatalf("HEAD with Range: %d %q %v", res.StatusCode, out, res.Header)
	}

	// another site gets no CORS (its page cannot read the media), and nobody without the session gets the bytes
	res, _ = h.raw(ana, http.MethodGet, "/v1/media/n1/m1", nil, map[string]string{"Origin": "https://outro.exemplo", "Range": "bytes=0-"})
	if res.Header.Get("Access-Control-Allow-Origin") != "" || res.Header.Get("Access-Control-Allow-Credentials") != "" {
		t.Fatalf("another site: %v", res.Header)
	}
	if res, out := h.raw(h.browser(), http.MethodGet, "/v1/media/n1/m1", nil, fromApp(map[string]string{"Range": "bytes=0-"})); res.StatusCode != 401 || strings.Contains(string(out), "abcd") {
		t.Fatalf("without the session: %d %q", res.StatusCode, out)
	}
}
