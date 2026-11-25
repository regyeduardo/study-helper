package server

import (
	"net/http"
	"regexp"
	"strconv"
	"testing"
)

// Server-Timing on every answer (spec 007, T019, research R1): the measures split the time of each operation between the network,
// the server and the device; "blobs" is the time spent on the storage, "app" the rest (Go and SQLite), "total" the whole answer.

var timingEntry = regexp.MustCompile(`(total|blobs|app);dur=([0-9.]+)`)

func timings(t *testing.T, header string) map[string]float64 {
	t.Helper()
	out := map[string]float64{}
	for _, match := range timingEntry.FindAllStringSubmatch(header, -1) {
		value, err := strconv.ParseFloat(match[2], 64)
		if err != nil {
			t.Fatalf("Server-Timing %q", header)
		}
		out[match[1]] = value
	}
	return out
}

func TestServerTimingOnEveryAnswer(t *testing.T) {
	h := newHarness(t)
	client, _ := h.account("enabled", true, "ana@exemplo.com")
	putRow(t, h, client, "n1", map[string]any{"itemKind": "file", "noteType": "explanation", "name": "Nota", "place": "app", "meta": map[string]any{}, "createdAt": "2026-11-24T00:00:00Z", "updatedAt": "2026-11-24T00:00:00Z"})
	putPart(t, h, client, "n1", "text", "um texto")
	for _, path := range []string{"/v1/health", "/v1/me", "/v1/library/map", "/v1/library/items/n1/parts/text", "/v1/rota-que-nao-existe"} {
		res, _ := h.raw(client, http.MethodGet, path, nil, nil)
		got := timings(t, res.Header.Get("Server-Timing"))
		if _, ok := got["total"]; !ok {
			t.Fatalf("%s: no total in %q", path, res.Header.Get("Server-Timing"))
		}
		if _, ok := got["blobs"]; !ok {
			t.Fatalf("%s: no blobs in %q", path, res.Header.Get("Server-Timing"))
		}
		if got["blobs"] > got["total"] || got["app"] < 0 {
			t.Fatalf("%s: %v", path, got)
		}
	}
	// reading a part spends time on the storage; the health check never touches it
	res, _ := h.raw(client, http.MethodGet, "/v1/health", nil, nil)
	if timings(t, res.Header.Get("Server-Timing"))["blobs"] != 0 {
		t.Fatalf("health touched the storage: %q", res.Header.Get("Server-Timing"))
	}
}

func TestServerTimingIsReadableByTheApp(t *testing.T) {
	h := newHarness(t)
	request, _ := http.NewRequest(http.MethodOptions, h.api.URL+"/v1/me", nil)
	request.Header.Set("Origin", appOrigin)
	request.Header.Set("Access-Control-Request-Method", http.MethodGet)
	res, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	get, _ := http.NewRequest(http.MethodGet, h.api.URL+"/v1/health", nil)
	get.Header.Set("Origin", appOrigin)
	answer, err := http.DefaultClient.Do(get)
	if err != nil {
		t.Fatal(err)
	}
	answer.Body.Close()
	// the Resource Timing of the browser reads it only with Timing-Allow-Origin
	if answer.Header.Get("Timing-Allow-Origin") != appOrigin {
		t.Fatalf("Timing-Allow-Origin %q", answer.Header.Get("Timing-Allow-Origin"))
	}
}
