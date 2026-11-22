package store

// The database backup (spec 003, FR-047 and SC-014): the real litestream binary replicates a database opened by Open to a
// replica in a local folder, the database is wrecked, and restoring "yesterday" (a moment in the past) brings back 100% of
// what existed at that moment. Production uses the same Litestream version with R2 as the replica (deploy/litestream.yml).
// Needs litestream: $LITESTREAM or on the PATH (the pipeline installs it); without it the test is skipped.

import (
	"bytes"
	"context"
	"database/sql"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"testing"
	"time"
)

func litestreamBin(t *testing.T) string {
	t.Helper()
	if p := os.Getenv("LITESTREAM"); p != "" {
		return p
	}
	p, err := exec.LookPath("litestream")
	if err != nil {
		t.Skip("litestream not installed: set LITESTREAM or put it on the PATH to run the backup test")
	}
	return p
}

// dump reads every row of every table, Litestream's own tables left out, as sorted text per table.
func dump(t *testing.T, db *sql.DB) map[string][]string {
	t.Helper()
	rows, err := db.Query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\_litestream%' ESCAPE '\' ORDER BY name`)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			t.Fatal(err)
		}
		names = append(names, n)
	}
	rows.Close()
	out := map[string][]string{}
	for _, n := range names {
		r, err := db.Query(fmt.Sprintf(`SELECT * FROM "%s"`, n))
		if err != nil {
			t.Fatal(err)
		}
		cols, _ := r.Columns()
		lines := []string{}
		for r.Next() {
			vals := make([]any, len(cols))
			ptrs := make([]any, len(cols))
			for i := range vals {
				ptrs[i] = &vals[i]
			}
			if err := r.Scan(ptrs...); err != nil {
				t.Fatal(err)
			}
			var b strings.Builder
			for i, v := range vals {
				if bs, ok := v.([]byte); ok {
					v = string(bs)
				}
				fmt.Fprintf(&b, "%s=%v|", cols[i], v)
			}
			lines = append(lines, b.String())
		}
		r.Close()
		sort.Strings(lines)
		out[n] = lines
	}
	return out
}

func dumpFile(t *testing.T, path string) map[string][]string {
	t.Helper()
	db, err := Open(path)
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	defer db.Close()
	return dump(t, db)
}

func rowCount(d map[string][]string) int {
	n := 0
	for _, rows := range d {
		n += len(rows)
	}
	return n
}

// same reports whether got has exactly the rows of want, and the first difference when not.
func same(want, got map[string][]string) (bool, string) {
	for table, rows := range want {
		g := got[table]
		if len(g) != len(rows) {
			return false, fmt.Sprintf("%s: %d rows, want %d", table, len(g), len(rows))
		}
		for i := range rows {
			if g[i] != rows[i] {
				return false, fmt.Sprintf("%s: row %q, want %q", table, g[i], rows[i])
			}
		}
	}
	for table := range got {
		if _, ok := want[table]; !ok {
			return false, "extra table " + table
		}
	}
	return true, ""
}

func addAccount(t *testing.T, db *sql.DB, id string, items int, metaBytes int) {
	t.Helper()
	now := time.Now().UTC().Format(time.RFC3339Nano)
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(`INSERT INTO user (id, email, name, status, app_enabled, created_at, updated_at) VALUES (?, ?, ?, 'enabled', 1, ?, ?)`,
		id, id+"@exemplo.com", "Pessoa "+id, now, now); err != nil {
		t.Fatal(err)
	}
	meta := fmt.Sprintf(`{"texto":%q}`, strings.Repeat("anotação ", metaBytes/10+1)[:metaBytes])
	for i := 0; i < items; i++ {
		if _, err := tx.Exec(`INSERT INTO library_items (user_id, id, item_kind, note_type, name, place, meta, created_at, updated_at, seq) VALUES (?, ?, 'file', 'Aula', ?, 'app', ?, ?, ?, ?)`,
			id, fmt.Sprintf("%s-nota-%04d", id, i), fmt.Sprintf("Aula %d", i), meta, now, now, i+1); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
}

func TestBackupRestoresYesterdayWithEverything(t *testing.T) {
	bin := litestreamBin(t)
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "estudo.db")
	config := filepath.Join(dir, "litestream.yml")
	// the production settings (a snapshot a day, 31 days) with short compaction and L0 retention, so that the restore below
	// goes through compacted files and the daily snapshot like a restore of yesterday does in production
	cfg := fmt.Sprintf(`snapshot:
  interval: 24h
  retention: 744h
levels:
  - interval: 2s
  - interval: 5s
l0-retention: 1s
l0-retention-check-interval: 1s
dbs:
  - path: %s
    replica:
      type: file
      path: %s
      sync-interval: 200ms
`, dbPath, filepath.Join(dir, "replica"))
	if err := os.WriteFile(config, []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}

	db, err := Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	addAccount(t, db, "ana", 50, 200)

	var logs bytes.Buffer
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	replicate := exec.CommandContext(ctx, bin, "replicate", "-config", config)
	replicate.Stdout, replicate.Stderr = &logs, &logs
	replicate.Cancel = func() error { return replicate.Process.Signal(syscall.SIGTERM) }
	if err := replicate.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if t.Failed() {
			t.Logf("litestream:\n%s", logs.String())
		}
	}()

	restores := 0
	restore := func(extra ...string) (string, error) {
		restores++
		out := filepath.Join(dir, fmt.Sprintf("restaurada-%d.db", restores))
		args := append([]string{"restore", "-config", config, "-integrity-check", "full", "-o", out}, extra...)
		msg, err := exec.Command(bin, append(args, dbPath)...).CombinedOutput()
		if err != nil {
			return "", fmt.Errorf("%v: %s", err, msg)
		}
		return out, nil
	}
	// waitReplicated restores the latest copy until it has exactly want
	waitReplicated := func(want map[string][]string) {
		t.Helper()
		deadline := time.Now().Add(30 * time.Second)
		for {
			out, err := restore()
			why := fmt.Sprint(err)
			if err == nil {
				var ok bool
				if ok, why = same(want, dumpFile(t, out)); ok {
					return
				}
			}
			if time.Now().After(deadline) {
				t.Fatalf("the replica did not reach the database: %s", why)
			}
			time.Sleep(500 * time.Millisecond)
		}
	}

	// the app keeps writing while Litestream replicates: a second account, edits and a delete
	addAccount(t, db, "bia", 30, 200)
	if _, err := db.Exec(`UPDATE library_items SET name = 'Aula renomeada' WHERE id = 'ana-nota-0001'`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`DELETE FROM library_items WHERE id = 'ana-nota-0002'`); err != nil {
		t.Fatal(err)
	}
	yesterday := dump(t, db)
	waitReplicated(yesterday)
	// past the compaction of the files above, then the moment of "yesterday's copy"
	time.Sleep(3 * time.Second)
	moment := time.Now().UTC()
	time.Sleep(1500 * time.Millisecond)

	// "today": another account with about 8 MB of notes (more than the 1000 pages that start the checkpoints of the app
	// and of Litestream), and changes to rows that existed yesterday
	addAccount(t, db, "caio", 2000, 4000)
	if _, err := db.Exec(`UPDATE library_items SET name = 'Mudada hoje' WHERE id = 'ana-nota-0003'`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`DELETE FROM user WHERE id = 'bia'`); err != nil {
		t.Fatal(err)
	}
	today := dump(t, db)
	waitReplicated(today)

	// the server loses the database: Litestream stops, the file is wrecked and its WAL is gone
	cancel()
	_ = replicate.Wait()
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dbPath, bytes.Repeat([]byte("estragado"), 4096), 0o600); err != nil {
		t.Fatal(err)
	}
	os.Remove(dbPath + "-wal")
	os.Remove(dbPath + "-shm")

	// a restore never writes over an existing database
	if msg, err := exec.Command(bin, "restore", "-config", config, "-o", dbPath, dbPath).CombinedOutput(); err == nil {
		t.Fatalf("restore wrote over the database in use: %s", msg)
	}

	out, err := restore("-timestamp", moment.Format(time.RFC3339Nano))
	if err != nil {
		t.Fatalf("restore of yesterday: %v", err)
	}
	if ok, why := same(yesterday, dumpFile(t, out)); !ok {
		t.Fatalf("yesterday's copy is not what existed yesterday: %s", why)
	}
	t.Logf("yesterday's copy: %d of %d rows in %d tables (100%%)", rowCount(yesterday), rowCount(yesterday), len(yesterday))

	out, err = restore()
	if err != nil {
		t.Fatalf("restore of the latest: %v", err)
	}
	if ok, why := same(today, dumpFile(t, out)); !ok {
		t.Fatalf("the latest copy is not what existed: %s", why)
	}
	t.Logf("latest copy: %d of %d rows (100%%)", rowCount(today), rowCount(today))
}
