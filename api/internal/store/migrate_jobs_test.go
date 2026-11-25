package store

import (
	"path/filepath"
	"testing"
)

// spec 007, história 2 (T052): 0006_jobs.sql makes the jobs table and its indexes; applying again changes nothing.
func TestJobsMigration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "estudo.db")
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	columns := map[string]bool{}
	rows, err := db.Query(`SELECT name FROM pragma_table_info('jobs')`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var name string
		_ = rows.Scan(&name)
		columns[name] = true
	}
	rows.Close()
	for _, want := range []string{"id", "user_id", "call", "kind", "file_id", "title", "request", "state", "stage", "fraction", "eta_at", "eta_basis", "last_progress_at",
		"last_progress", "stalled_since", "result", "error", "error_code", "attempt", "ticket_hash", "ticket_expires_at", "device_id", "created_at", "started_at", "finished_at", "updated_at"} {
		if !columns[want] {
			t.Fatalf("jobs has no %s (%v)", want, columns)
		}
	}
	for _, index := range []string{"jobs_by_user_state", "jobs_by_state", "jobs_by_kind"} {
		var found int
		_ = db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = ?`, index).Scan(&found)
		if found != 1 {
			t.Fatalf("no index %s", index)
		}
	}
	if err := Migrate(db); err != nil {
		t.Fatalf("again: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO jobs (id, user_id, call, kind, title, request, state, created_at, updated_at) VALUES ('j', 'u', 'c', 'c', 't', '{}', 'parado', 'x', 'x')`); err == nil {
		t.Fatal("a state out of the list went in")
	}
}
