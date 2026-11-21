package server

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"time"
)

// writeJSON answers JSON that is never cached (contracts, common rules).
func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// fail answers an error as a code and its data, never a sentence: the app writes what the person reads.
func fail(w http.ResponseWriter, status int, code string, data map[string]any) {
	body := map[string]any{"error": code}
	for key, value := range data {
		body[key] = value
	}
	writeJSON(w, status, body)
}

func readJSON(r *http.Request, into any) bool {
	r.Body = http.MaxBytesReader(nil, r.Body, 1<<20)
	return json.NewDecoder(r.Body).Decode(into) == nil
}

func nowUTC() time.Time { return time.Now().UTC() }

func stamp(t time.Time) string { return t.UTC().Format(time.RFC3339Nano) }

func randomToken(bytes int) string {
	buffer := make([]byte, bytes)
	_, _ = rand.Read(buffer)
	return base64.RawURLEncoding.EncodeToString(buffer)
}

func newID() string { return randomToken(16) }

func sha256Hex(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}
