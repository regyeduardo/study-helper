package store

import (
	"path/filepath"
	"testing"
)

// T006 (spec 004, data-model.md, approved 21/11; cards by language since 0005, 24/11): the lang_* tables, with their keys and checks.
func TestLanguagesMigration(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "estudo.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, table := range []string{"lang_languages", "lang_texts", "lang_items", "lang_item_needs", "lang_equivalences", "lang_text_items", "lang_cards", "lang_text_cards", "lang_card_items", "lang_card_schedule", "lang_answers", "lang_progress"} {
		var name string
		if err := db.QueryRow(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, table).Scan(&name); err != nil {
			t.Fatalf("%s: %v", table, err)
		}
	}
	now := "2026-11-23T21:00:00Z"
	mustExec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.Exec(query, args...); err != nil {
			t.Fatalf("%s: %v", query, err)
		}
	}
	mustFail := func(why, query string, args ...any) {
		t.Helper()
		if _, err := db.Exec(query, args...); err == nil {
			t.Fatalf("%s should be refused", why)
		}
	}
	mustExec(`INSERT INTO user (id, email, created_at, updated_at) VALUES ('u1', 'ana@exemplo.com', ?, ?)`, now, now)
	mustExec(`INSERT INTO lang_languages (user_id, code, name, locale, native, created_at) VALUES ('u1', 'en', 'Inglês', 'en-US', 'pt', ?)`, now)
	mustFail("the same language twice", `INSERT INTO lang_languages (user_id, code, name, locale, native, created_at) VALUES ('u1', 'en', 'Inglês', 'en-US', 'pt', ?)`, now)
	mustExec(`INSERT INTO lang_texts (user_id, id, language, title, body, status, created_at) VALUES ('u1', 't1', 'en', 'Juros', 'Compound interest…', 'generating', ?)`, now)
	mustFail("a text status off the list", `INSERT INTO lang_texts (user_id, id, language, title, body, status, created_at) VALUES ('u1', 't2', 'en', 'X', 'y', 'done', ?)`, now)
	mustFail("a text of a language not studied", `INSERT INTO lang_texts (user_id, id, language, title, body, status, created_at) VALUES ('u1', 't3', 'sv', 'X', 'y', 'ready', ?)`, now)
	mustExec(`INSERT INTO lang_cards (user_id, language, id, type, skill, data, created_at) VALUES ('u1', 'en', 'c1', 'speak', 'speak', '{}', ?)`, now)
	mustFail("a card type off the list", `INSERT INTO lang_cards (user_id, language, id, type, skill, data, created_at) VALUES ('u1', 'en', 'c2', 'chat', 'speak', '{}', ?)`, now)
	mustExec(`INSERT INTO lang_answers (user_id, text_id, card_id, stage, prompt_lang, ok, retry, created_at) VALUES ('u1', 't1', 'c1', 'practice', 'target', NULL, 0, ?)`, now)
	// deleting the account takes every row with it
	mustExec(`DELETE FROM user WHERE id = 'u1'`)
	var left int
	_ = db.QueryRow(`SELECT (SELECT COUNT(*) FROM lang_languages) + (SELECT COUNT(*) FROM lang_texts) + (SELECT COUNT(*) FROM lang_cards) + (SELECT COUNT(*) FROM lang_answers)`).Scan(&left)
	if left != 0 {
		t.Fatalf("rows left after the account went: %d", left)
	}
}
