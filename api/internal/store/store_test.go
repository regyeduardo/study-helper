package store

import (
	"path/filepath"
	"testing"
	"time"
)

var tables = []string{"app_settings", "auth_google", "devices", "promo_code_uses", "promo_codes", "schema_migrations", "shared_links", "shared_links_used", "user"}

func list(t *testing.T, path string) []string {
	t.Helper()
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	rows, err := db.Query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var names []string
	for rows.Next() {
		var name string
		_ = rows.Scan(&name)
		names = append(names, name)
	}
	return names
}

func TestMigrationsCreateTheTablesInEnglish(t *testing.T) {
	names := list(t, filepath.Join(t.TempDir(), "estudo.db"))
	if len(names) != len(tables) {
		t.Fatalf("tables = %v, want %v", names, tables)
	}
	for i := range tables {
		if names[i] != tables[i] {
			t.Fatalf("tables = %v, want %v", names, tables)
		}
	}
}

func TestMigrationsAgainChangeNothing(t *testing.T) {
	path := filepath.Join(t.TempDir(), "estudo.db")
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE app_settings SET value = '0' WHERE key = 'require_code'`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	db, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var count int
	var value string
	_ = db.QueryRow(`SELECT COUNT(*), MAX(value) FROM app_settings`).Scan(&count, &value)
	if count != 1 || value != "0" {
		t.Fatalf("app_settings = %d rows, value %q; want 1 row, value 0", count, value)
	}
}

func TestTheSchemaRefusesWhatItMust(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "estudo.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	now := time.Now().UTC().Format(time.RFC3339)
	insert := func(id, sub, email, status string) error {
		_, err := db.Exec(`INSERT INTO user (id, google_sub, email, status, created_at, updated_at) VALUES (?, NULLIF(?, ''), ?, ?, ?, ?)`, id, sub, email, status, now, now)
		return err
	}
	if err := insert("a", "sub-1", "ana@exemplo.com", "enabled"); err != nil {
		t.Fatal(err)
	}
	if insert("b", "sub-2", "bruno@exemplo.com", "liberada") == nil {
		t.Fatal("an unknown status was accepted")
	}
	if insert("c", "sub-1", "carla@exemplo.com", "no-code") == nil {
		t.Fatal("the same Google account was accepted twice")
	}
	if insert("d", "", "ana@exemplo.com", "no-code") == nil {
		t.Fatal("the same e-mail was accepted twice")
	}
	// e-mail and password accounts have no Google account: several of them are fine
	if err := insert("e", "", "eva@exemplo.com", "no-code"); err != nil {
		t.Fatal(err)
	}
	if err := insert("f", "", "fabio@exemplo.com", "no-code"); err != nil {
		t.Fatal(err)
	}
}
