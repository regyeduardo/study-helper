package store

import (
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// hierarchy_backups: spec 005 (migration 0003)
var tables = []string{"ai_usage", "app_settings", "auth_google", "devices", "hierarchy_backups", "jobs", "lang_answers", "lang_card_items", "lang_card_schedule", "lang_cards", "lang_equivalences", "lang_item_needs", "lang_items", "lang_languages", "lang_progress", "lang_text_cards", "lang_text_items", "lang_texts", "library_index", "library_items", "orphans", "promo_code_uses", "promo_codes", "schema_migrations", "shared_links", "shared_links_used", "upload_parts", "uploads", "user"}

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

// Entrega 4 (T061): the library map, the index pointer, the uploads in parts and the orphans, as approved on 2026-11-21.
func TestLibraryTablesFollowTheApprovedModel(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "estudo.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	columns := func(table string) map[string]string {
		rows, err := db.Query(`SELECT name, type, "notnull", pk FROM pragma_table_info(?)`, table)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		out := map[string]string{}
		for rows.Next() {
			var name, kind string
			var notNull, pk int
			_ = rows.Scan(&name, &kind, &notNull, &pk)
			out[name] = kind
			if notNull == 1 {
				out[name] += " NOT NULL"
			}
			if pk > 0 {
				out[name] += " PK"
			}
		}
		return out
	}
	items := columns("library_items")
	// spec 005 (migration 0003): place is empty on a folder and place_own is gone
	for name, want := range map[string]string{
		"user_id": "TEXT NOT NULL PK", "id": "TEXT NOT NULL PK", "item_kind": "TEXT NOT NULL", "note_type": "TEXT", "name": "TEXT NOT NULL",
		"folder_id": "TEXT", "parent_file_id": "TEXT", "place": "TEXT", "recording": "INTEGER NOT NULL",
		"position": "REAL NOT NULL", "meta": "TEXT NOT NULL", "parts": "TEXT NOT NULL", "media": "TEXT", "note_bytes": "INTEGER NOT NULL",
		"media_bytes": "INTEGER NOT NULL", "drive_ref": "TEXT", "created_at": "TEXT NOT NULL", "updated_at": "TEXT NOT NULL", "trashed_at": "TEXT",
		"trashed_with": "TEXT", "removed_at": "TEXT", "rev": "INTEGER NOT NULL", "seq": "INTEGER NOT NULL",
	} {
		if items[name] != want {
			t.Errorf("library_items.%s = %q, want %q", name, items[name], want)
		}
	}
	if len(items) != 23 {
		t.Errorf("library_items has %d columns, want 23: %v", len(items), items)
	}
	uploads := columns("uploads")
	for _, name := range []string{"id", "user_id", "item_id", "media_id", "object_key", "file_name", "mime", "declared_bytes", "part_size", "status", "created_at", "updated_at"} {
		if _, ok := uploads[name]; !ok {
			t.Errorf("uploads has no %s", name)
		}
	}
	for table, want := range map[string][]string{"upload_parts": {"upload_id", "n", "etag", "bytes", "received_at"}, "orphans": {"object_key", "user_id", "reason", "since"}, "library_index": {"user_id", "version", "bytes", "updated_at"}} {
		got := columns(table)
		if len(got) != len(want) {
			t.Errorf("%s = %v, want %v", table, got, want)
		}
	}
	var indexes []string
	rows, err := db.Query(`SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' AND tbl_name IN ('library_items', 'uploads', 'orphans') ORDER BY name`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var name string
		_ = rows.Scan(&name)
		indexes = append(indexes, name)
	}
	rows.Close()
	wantIndexes := "library_items_by_folder library_items_by_parent library_items_by_seq library_items_by_trash library_items_recordings orphans_by_since uploads_one_open"
	if got := strings.Join(indexes, " "); got != wantIndexes {
		t.Errorf("indexes = %q, want %q", got, wantIndexes)
	}

	// the checks hold
	now := time.Now().UTC().Format(time.RFC3339)
	if _, err := db.Exec(`INSERT INTO user (id, email, created_at, updated_at) VALUES ('u1', 'a@b.c', ?, ?)`, now, now); err != nil {
		t.Fatal(err)
	}
	insert := func(kind, place string) error {
		_, err := db.Exec(`INSERT INTO library_items (user_id, id, item_kind, name, place, created_at, updated_at, seq) VALUES ('u1', ?, ?, 'x', ?, ?, ?, 1)`, kind+place, kind, place, now, now)
		return err
	}
	if err := insert("file", "app"); err != nil {
		t.Fatalf("a note in the App: %v", err)
	}
	if insert("pasta", "app") == nil || insert("folder", "local") == nil {
		t.Fatal("item_kind and place accept anything")
	}
	if _, err := db.Exec(`INSERT INTO uploads (id, user_id, item_id, media_id, object_key, file_name, mime, declared_bytes, created_at, updated_at) VALUES ('up1', 'u1', 'n', 'm', 'k', 'a.webm', 'video/webm', 10, ?, ?)`, now, now); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO uploads (id, user_id, item_id, media_id, object_key, file_name, mime, declared_bytes, created_at, updated_at) VALUES ('up2', 'u1', 'n', 'm', 'k', 'a.webm', 'video/webm', 10, ?, ?)`, now, now); err == nil {
		t.Fatal("two open uploads for the same media")
	}
	if _, err := db.Exec(`INSERT INTO upload_parts (upload_id, n, etag, bytes, received_at) VALUES ('up1', 10001, 'e', 1, ?)`, now); err == nil {
		t.Fatal("part number above 10000")
	}
}
