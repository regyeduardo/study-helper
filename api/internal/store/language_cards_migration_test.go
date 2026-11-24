package store

import (
	"database/sql"
	"fmt"
	"io/fs"
	"path/filepath"
	"sort"
	"testing"

	"github.com/regyeduardo/study-helper/api/migrations"
)

// migrateUntil applies the migrations before `stop` (by name), as Migrate does, so a test can put old data in first.
func migrateUntil(t *testing.T, db *sql.DB, stop string) {
	t.Helper()
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	names, _ := fs.Glob(migrations.Files, "*.sql")
	sort.Strings(names)
	for _, name := range names {
		if name >= stop {
			return
		}
		body, _ := migrations.Files.ReadFile(name)
		if _, err := db.Exec(string(body)); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if _, err := db.Exec(`INSERT INTO schema_migrations (name, applied_at) VALUES (?, '2026-11-24T00:00:00Z')`, name); err != nil {
			t.Fatal(err)
		}
	}
}

// T112 (spec 004, data-model.md › Mudança de 24/11, approved): cards go from the text to the language. The same test card of an
// item in two texts becomes one card; a practice card id two texts share gets the text in front; answers keep pointing at their
// card, with the language and the FSRS rating; lang_knowledge goes; deleting a text keeps its cards.
func TestLanguageCardsMigration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "estudo.db")
	db, err := sql.Open("sqlite", fmt.Sprintf("file:%s?_pragma=foreign_keys(1)", path))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	migrateUntil(t, db, "0005")
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.Exec(query, args...); err != nil {
			t.Fatalf("%s: %v", query, err)
		}
	}
	now := "2026-11-24T10:00:00Z"
	exec(`INSERT INTO user (id, email, created_at, updated_at) VALUES ('u1', 'ana@exemplo.com', ?, ?)`, now, now)
	exec(`INSERT INTO lang_languages (user_id, code, name, locale, native, created_at) VALUES ('u1', 'en', 'Inglês', 'en-US', 'pt', ?)`, now)
	exec(`INSERT INTO lang_texts (user_id, id, language, title, body, status, created_at) VALUES ('u1', 't1', 'en', 'Música A', 'I give up', 'ready', '2026-11-20T10:00:00Z')`)
	exec(`INSERT INTO lang_texts (user_id, id, language, title, body, status, created_at) VALUES ('u1', 't2', 'en', 'Texto B', 'Never give up', 'ready', '2026-11-21T10:00:00Z')`)
	exec(`INSERT INTO lang_items (user_id, language, id, area, kind, label, meaning, data, created_at, updated_at) VALUES ('u1', 'en', 'give_up', 'lexico', 'phrasal_verb', 'give up', 'desistir', '{}', ?, ?)`, now, now)
	card := func(text, id, part, item string, position int, kind, skill string) {
		exec(`INSERT INTO lang_cards (user_id, text_id, id, part, item_id, position, type, skill, data) VALUES ('u1', ?, ?, ?, NULLIF(?, ''), ?, ?, ?, ?)`,
			text, id, part, item, position, kind, skill, fmt.Sprintf(`{"id":%q,"type":%q,"skill":%q,"q":"?"}`, id, kind, skill))
		exec(`INSERT INTO lang_card_items (user_id, text_id, card_id, item_id, role) VALUES ('u1', ?, ?, 'give_up', 'covers')`, text, id)
	}
	card("t1", "give_up__1", "test", "give_up", 0, "mc", "read")
	card("t1", "p1", "practice", "", 1, "dictation", "listen")
	card("t1", "c1", "context", "", 2, "mc", "read")
	card("t2", "give_up__1", "test", "give_up", 0, "mc", "read")
	card("t2", "p1", "practice", "", 1, "order", "read")
	exec(`INSERT INTO lang_answers (user_id, text_id, card_id, stage, prompt_lang, ok, retry, created_at) VALUES ('u1', 't1', 'give_up__1', 'test', 'native', 1, 0, ?)`, now)
	exec(`INSERT INTO lang_answers (user_id, text_id, card_id, stage, prompt_lang, ok, retry, created_at) VALUES ('u1', 't1', 'give_up__1', 'test', 'native', 1, 1, ?)`, now)
	exec(`INSERT INTO lang_answers (user_id, text_id, card_id, stage, prompt_lang, ok, retry, created_at) VALUES ('u1', 't2', 'p1', 'practice', 'native', 0, 0, ?)`, now)
	exec(`INSERT INTO lang_answers (user_id, text_id, card_id, stage, prompt_lang, ok, retry, created_at) VALUES ('u1', 't2', 'p1', 'practice', 'native', NULL, 0, ?)`, now)
	exec(`INSERT INTO lang_knowledge (user_id, language, item_id, skill, status, interval_days, streak, due_at, last_ok, last_at) VALUES ('u1', 'en', 'give_up', 'recognize', 'learning', 1, 1, ?, 1, ?)`, now, now)

	if err := Migrate(db); err != nil {
		t.Fatal(err)
	}

	var gone int
	_ = db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'lang_knowledge'`).Scan(&gone)
	if gone != 0 {
		t.Fatal("lang_knowledge should be gone")
	}
	rows, err := db.Query(`SELECT id, language, COALESCE(item_id, ''), type, json_extract(data, '$.id') FROM lang_cards ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	got := []string{}
	for rows.Next() {
		var id, language, item, kind, inside string
		_ = rows.Scan(&id, &language, &item, &kind, &inside)
		got = append(got, fmt.Sprintf("%s|%s|%s|%s|%s", id, language, item, kind, inside))
	}
	rows.Close()
	want := []string{"c1|en||mc|c1", "give_up__1|en|give_up|mc|give_up__1", "p1|en||dictation|p1", "t2.p1|en||order|t2.p1"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("cards\n got %v\nwant %v", got, want)
	}
	links := []string{}
	rows, _ = db.Query(`SELECT text_id, card_id, part, position FROM lang_text_cards ORDER BY text_id, position`)
	for rows.Next() {
		var text, id, part string
		var position int
		_ = rows.Scan(&text, &id, &part, &position)
		links = append(links, fmt.Sprintf("%s:%s:%s:%d", text, id, part, position))
	}
	rows.Close()
	wantLinks := []string{"t1:give_up__1:test:0", "t1:p1:practice:1", "t1:c1:context:2", "t2:give_up__1:test:0", "t2:t2.p1:practice:1"}
	if fmt.Sprint(links) != fmt.Sprint(wantLinks) {
		t.Fatalf("text cards\n got %v\nwant %v", links, wantLinks)
	}
	var covers int
	_ = db.QueryRow(`SELECT COUNT(*) FROM lang_card_items WHERE language = 'en' AND item_id = 'give_up' AND role = 'covers'`).Scan(&covers)
	if covers != 4 {
		t.Fatalf("card items: %d, want 4 (one per card of the language)", covers)
	}
	answers := []string{}
	rows, _ = db.Query(`SELECT card_id, language, COALESCE(rating, 0) FROM lang_answers ORDER BY id`)
	for rows.Next() {
		var id, language string
		var rating int
		_ = rows.Scan(&id, &language, &rating)
		answers = append(answers, fmt.Sprintf("%s|%s|%d", id, language, rating))
	}
	rows.Close()
	wantAnswers := []string{"give_up__1|en|3", "give_up__1|en|2", "t2.p1|en|1", "t2.p1|en|0"}
	if fmt.Sprint(answers) != fmt.Sprint(wantAnswers) {
		t.Fatalf("answers\n got %v\nwant %v", answers, wantAnswers)
	}

	// the schedule of each card, and its checks
	exec(`INSERT INTO lang_card_schedule (user_id, language, card_id, state, step, stability, difficulty, due_at, last_review_at, scheduled_days, reps, lapses)
		VALUES ('u1', 'en', 'give_up__1', 'review', 0, 2.3, 2.1, '2026-11-26T10:00:00Z', ?, 2, 2, 0)`, now)
	if _, err := db.Exec(`INSERT INTO lang_card_schedule (user_id, language, card_id, state, step, reps, lapses) VALUES ('u1', 'en', 'p1', 'done', 0, 0, 0)`); err == nil {
		t.Fatal("a schedule state off the list should be refused")
	}
	if _, err := db.Exec(`INSERT INTO lang_card_schedule (user_id, language, card_id, state, step, reps, lapses) VALUES ('u1', 'en', 'nope', 'new', 0, 0, 0)`); err == nil {
		t.Fatal("a schedule of a card that does not exist should be refused")
	}
	// a reused card is one per language, whatever its key
	exec(`UPDATE lang_cards SET reuse_key = 'k1' WHERE id = 'p1'`)
	if _, err := db.Exec(`UPDATE lang_cards SET reuse_key = 'k1' WHERE id = 't2.p1'`); err == nil {
		t.Fatal("two cards of the language with the same reuse key should be refused")
	}

	// deleting a text takes only its links: cards, schedule and answers stay in the base
	exec(`DELETE FROM lang_texts WHERE id = 't2'`)
	var cards, schedules, kept, linked int
	_ = db.QueryRow(`SELECT (SELECT COUNT(*) FROM lang_cards), (SELECT COUNT(*) FROM lang_card_schedule), (SELECT COUNT(*) FROM lang_answers), (SELECT COUNT(*) FROM lang_text_cards WHERE text_id = 't2')`).Scan(&cards, &schedules, &kept, &linked)
	if cards != 4 || schedules != 1 || kept != 4 || linked != 0 {
		t.Fatalf("after deleting the text: cards %d, schedules %d, answers %d, links %d", cards, schedules, kept, linked)
	}
	// deleting the account takes everything
	exec(`DELETE FROM user WHERE id = 'u1'`)
	var left int
	_ = db.QueryRow(`SELECT (SELECT COUNT(*) FROM lang_cards) + (SELECT COUNT(*) FROM lang_card_schedule) + (SELECT COUNT(*) FROM lang_text_cards) + (SELECT COUNT(*) FROM lang_card_items) + (SELECT COUNT(*) FROM lang_answers)`).Scan(&left)
	if left != 0 {
		t.Fatalf("rows left after the account went: %d", left)
	}
}
