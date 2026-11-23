package store

import (
	"database/sql"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/regyeduardo/study-helper/api/migrations"
)

// Spec 005 (T003): migration 0003 takes the place away from folders, drops place_own, adds user.hierarchy_at and the
// hierarchy_backups table; every row of before comes over whole.

// openBefore0003 opens a database with only 0001 and 0002 applied, as a server of before the spec 005.
func openBefore0003(t *testing.T) *sql.DB {
	t.Helper()
	path := filepath.Join(t.TempDir(), "estudo.db")
	db, err := sql.Open("sqlite", fmt.Sprintf("file:%s?_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)", path))
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { db.Close() })
	if _, err := db.Exec(`CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"0001_initial.sql", "0002_library.sql"} {
		body, err := migrations.Files.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(string(body)); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if _, err := db.Exec(`INSERT INTO schema_migrations (name, applied_at) VALUES (?, '2026-11-21T00:00:00Z')`, name); err != nil {
			t.Fatal(err)
		}
	}
	return db
}

// itemsDump is every row of library_items as text, without place and place_own, by id.
func itemsDump(t *testing.T, db *sql.DB) map[string]string {
	t.Helper()
	rows, err := db.Query(`SELECT user_id, id, item_kind, note_type, name, folder_id, parent_file_id, recording, position, meta, parts, media, note_bytes,
		media_bytes, drive_ref, created_at, updated_at, trashed_at, trashed_with, removed_at, rev, seq FROM library_items ORDER BY user_id, id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	cols, _ := rows.Columns()
	out := map[string]string{}
	for rows.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			t.Fatal(err)
		}
		var b strings.Builder
		for i, v := range vals {
			if bs, ok := v.([]byte); ok {
				v = string(bs)
			}
			fmt.Fprintf(&b, "%s=%v|", cols[i], v)
		}
		out[fmt.Sprint(vals[0], "/", vals[1])] = b.String()
	}
	return out
}

func places(t *testing.T, db *sql.DB) map[string]sql.NullString {
	t.Helper()
	rows, err := db.Query(`SELECT user_id || '/' || id, place FROM library_items`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := map[string]sql.NullString{}
	for rows.Next() {
		var id string
		var place sql.NullString
		_ = rows.Scan(&id, &place)
		out[id] = place
	}
	return out
}

func TestMigration0003KeepsEveryRowAndTakesThePlaceFromFolders(t *testing.T) {
	db := openBefore0003(t)
	now := time.Now().UTC().Format(time.RFC3339)
	for _, id := range []string{"u1", "u2"} {
		if _, err := db.Exec(`INSERT INTO user (id, email, seq, created_at, updated_at) VALUES (?, ?, 9, ?, ?)`, id, id+"@exemplo.com", now, now); err != nil {
			t.Fatal(err)
		}
	}
	old := []string{
		// folders of before always had a place, sometimes their own
		`('u1', 'f1', 'folder', NULL, 'Faculdade', NULL, NULL, 'drive', 1, 0, 1, '{"name":"Faculdade"}', '{}', NULL, 0, 0, NULL, ?, ?, NULL, NULL, NULL, 2, 3)`,
		`('u1', 'f2', 'folder', NULL, 'Cálculo', 'f1', NULL, 'app', 0, 0, 2, '{}', '{}', NULL, 0, 0, NULL, ?, ?, '2026-11-21T12:00:00Z', 'f2', NULL, 1, 4)`,
		`('u1', 'n1', 'file', 'class', 'Aula 1', 'f2', NULL, 'app', 1, 1, 1.5, '{"name":"Aula 1"}', '{"text":"v1"}', '{"id":"m1","key":"k","mime":"video/webm","bytes":10,"status":"stored"}', 7, 10, NULL, ?, ?, NULL, NULL, NULL, 3, 5)`,
		`('u1', 'n2', 'file', 'note', 'Kickoff', 'f1', 'n1', 'drive', 0, 0, 0, '{}', '{}', NULL, 0, 0, 'drive-123', ?, ?, NULL, NULL, NULL, 1, 6)`,
		`('u1', 'n3', 'file', 'note', 'Apagada', NULL, NULL, 'app', 0, 0, 0, '{}', '{}', NULL, 0, 0, NULL, ?, ?, NULL, NULL, '2026-11-20T00:00:00Z', 4, 7)`,
		`('u2', 'f1', 'folder', NULL, 'Outra conta', NULL, NULL, 'app', 1, 0, 0, '{}', '{}', NULL, 0, 0, NULL, ?, ?, NULL, NULL, NULL, 1, 1)`,
	}
	for _, values := range old {
		if _, err := db.Exec(`INSERT INTO library_items (user_id, id, item_kind, note_type, name, folder_id, parent_file_id, place, place_own, recording, position,
			meta, parts, media, note_bytes, media_bytes, drive_ref, created_at, updated_at, trashed_at, trashed_with, removed_at, rev, seq) VALUES `+values, now, now); err != nil {
			t.Fatal(err)
		}
	}
	before := itemsDump(t, db)
	beforePlaces := places(t, db)

	if err := Migrate(db); err != nil {
		t.Fatal(err)
	}

	after := itemsDump(t, db)
	if len(after) != len(before) {
		t.Fatalf("rows: %d after, %d before", len(after), len(before))
	}
	for key, row := range before {
		if after[key] != row {
			t.Errorf("row %s changed:\n before %s\n after  %s", key, row, after[key])
		}
	}
	afterPlaces := places(t, db)
	for _, id := range []string{"u1/f1", "u1/f2", "u2/f1"} {
		if afterPlaces[id].Valid {
			t.Errorf("folder %s kept a place: %v", id, afterPlaces[id])
		}
	}
	for _, id := range []string{"u1/n1", "u1/n2", "u1/n3"} {
		if !beforePlaces[id].Valid || afterPlaces[id] != beforePlaces[id] {
			t.Errorf("note %s: place %v, want %v", id, afterPlaces[id], beforePlaces[id])
		}
	}

	// library_items: place may be empty, place_own is gone, the indexes are back
	columns := map[string]string{}
	rows, err := db.Query(`SELECT name, type, "notnull" FROM pragma_table_info('library_items')`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var name, kind string
		var notNull int
		_ = rows.Scan(&name, &kind, &notNull)
		columns[name] = kind
		if notNull == 1 {
			columns[name] += " NOT NULL"
		}
	}
	rows.Close()
	if _, ok := columns["place_own"]; ok {
		t.Error("place_own is still there")
	}
	if columns["place"] != "TEXT" || len(columns) != 23 {
		t.Errorf("library_items columns = %v", columns)
	}
	var indexes []string
	rows, err = db.Query(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'library_items' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var name string
		_ = rows.Scan(&name)
		indexes = append(indexes, name)
	}
	rows.Close()
	if got := strings.Join(indexes, " "); got != "library_items_by_folder library_items_by_parent library_items_by_seq library_items_by_trash library_items_recordings" {
		t.Errorf("indexes = %q", got)
	}

	// user.hierarchy_at, empty for everyone of before
	var empty int
	if err := db.QueryRow(`SELECT COUNT(*) FROM user WHERE hierarchy_at IS NULL`).Scan(&empty); err != nil || empty != 2 {
		t.Fatalf("hierarchy_at: %d %v", empty, err)
	}

	// the checks: a folder has no place, a note has app or drive
	insert := func(id, kind string, place any) error {
		_, err := db.Exec(`INSERT INTO library_items (user_id, id, item_kind, name, place, created_at, updated_at, seq) VALUES ('u1', ?, ?, 'x', ?, ?, ?, 10)`, id, kind, place, now, now)
		return err
	}
	if err := insert("ok-folder", "folder", nil); err != nil {
		t.Fatalf("a folder without place: %v", err)
	}
	if err := insert("ok-app", "file", "app"); err != nil {
		t.Fatalf("a note in the App: %v", err)
	}
	if err := insert("ok-drive", "file", "drive"); err != nil {
		t.Fatalf("a note in the Drive: %v", err)
	}
	for name, try := range map[string]func() error{
		"a folder with a place": func() error { return insert("x1", "folder", "drive") },
		"a note without place":  func() error { return insert("x2", "file", nil) },
		"a note in Local":       func() error { return insert("x3", "file", "local") },
	} {
		if try() == nil {
			t.Errorf("%s was accepted", name)
		}
	}

	// hierarchy_backups: one copy per account and id, gone with the account
	if _, err := db.Exec(`INSERT INTO hierarchy_backups (user_id, id, snapshot, folders, files, created_at) VALUES ('u2', 'b1', '{"folders":[],"files":[]}', 0, 0, ?)`, now); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO hierarchy_backups (user_id, id, snapshot, folders, files, created_at) VALUES ('u2', 'b1', '{}', 0, 0, ?)`, now); err == nil {
		t.Fatal("the same backup twice")
	}
	if _, err := db.Exec(`INSERT INTO hierarchy_backups (user_id, id, snapshot, folders, files, created_at) VALUES ('nobody', 'b2', '{}', 0, 0, ?)`, now); err == nil {
		t.Fatal("a backup of no account")
	}
	if _, err := db.Exec(`DELETE FROM user WHERE id = 'u2'`); err != nil {
		t.Fatal(err)
	}
	var backups int
	_ = db.QueryRow(`SELECT COUNT(*) FROM hierarchy_backups`).Scan(&backups)
	if backups != 0 {
		t.Fatalf("backups of a deleted account: %d", backups)
	}

	// applying again changes nothing
	if err := Migrate(db); err != nil {
		t.Fatal(err)
	}
}
