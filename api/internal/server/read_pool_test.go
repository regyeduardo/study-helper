package server

import (
	"net/http"
	"testing"
	"time"
)

// Reads without a queue (spec 007, T035, research R5): one connection writes, as before (no "database is locked" between writers),
// and a pool of read-only connections answers the reads, so a long write does not hold the map, a note or the session of other
// requests. SQLite in WAL lets readers go on while a writer writes.

func TestReadsDoNotWaitForAWrite(t *testing.T) {
	h := newHarness(t)
	client, userID := h.account("enabled", true, "ana@exemplo.com")
	putRow(t, h, client, "n1", map[string]any{"itemKind": "file", "noteType": "explanation", "name": "Nota", "place": "app", "meta": map[string]any{}, "createdAt": "2026-11-24T00:00:00Z", "updatedAt": "2026-11-24T00:00:00Z"})
	// a write that holds the writing connection (a big batch, a slow storage)
	tx, err := h.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(`UPDATE user SET name = 'segurando' WHERE id = ?`, userID); err != nil {
		t.Fatal(err)
	}
	type answer struct {
		path   string
		status int
		took   time.Duration
	}
	done := make(chan answer, 3)
	for _, path := range []string{"/v1/me", "/v1/library/map", "/v1/library/items/n1"} {
		go func(path string) {
			started := time.Now()
			res, _ := h.raw(client, http.MethodGet, path, nil, nil)
			done <- answer{path, res.StatusCode, time.Since(started)}
		}(path)
	}
	for range 3 {
		select {
		case got := <-done:
			if got.status != http.StatusOK || got.took > 2*time.Second {
				t.Fatalf("%s: %d in %v while a write was open", got.path, got.status, got.took)
			}
		case <-time.After(3 * time.Second):
			tx.Rollback()
			t.Fatal("a read waited for the open write")
		}
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	// and writing goes on as before
	putRow(t, h, client, "n2", map[string]any{"itemKind": "file", "noteType": "explanation", "name": "Outra", "place": "app", "meta": map[string]any{}, "createdAt": "2026-11-24T00:00:00Z", "updatedAt": "2026-11-24T00:00:00Z"})
}

func TestAReadSeesTheWriteJustMade(t *testing.T) {
	h := newHarness(t)
	client, _ := h.account("enabled", true, "ana@exemplo.com")
	for i := range 20 {
		name := "Nota " + string(rune('A'+i))
		putRow(t, h, client, "r"+string(rune('a'+i)), map[string]any{"itemKind": "file", "noteType": "explanation", "name": name, "place": "app", "meta": map[string]any{}, "createdAt": "2026-11-24T00:00:00Z", "updatedAt": "2026-11-24T00:00:00Z"})
		res, body := h.do(client, call{path: "/v1/library/items/r" + string(rune('a'+i))})
		if res.StatusCode != 200 || body["name"] != name {
			t.Fatalf("read after write %d: %d %v", i, res.StatusCode, body["name"])
		}
	}
}
