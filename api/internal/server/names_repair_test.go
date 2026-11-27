package server

import (
	"context"
	"encoding/json"
	"testing"
)

// Spec 005, FR-022 (T052; dono, 25/11: "Juntar"): the repeated names from before the rule are undone once (cmd/juntar-nomes, with a
// copy of the database first): folders of the same name in the same folder become one (what is inside goes to the oldest, joining the
// folders inside of the same name too; the empty one goes to the Trash); notes of the same name stay, and the newer get " (2)".
func TestRepairNamesJoinsFoldersAndNumbersNotes(t *testing.T) {
	h := newHarness(t)
	h.account("enabled", true, "ana@exemplo.com")
	var userID string
	if err := h.db.QueryRow(`SELECT id FROM user WHERE email = ?`, "ana@exemplo.com").Scan(&userID); err != nil {
		t.Fatal(err)
	}
	put := func(id, kind, name, folder, created string, trashed bool) {
		t.Helper()
		meta := map[string]any{"id": id, "name": name}
		if kind == "folder" {
			meta["parentId"] = orNull(folder)
		} else {
			meta["folderId"] = orNull(folder)
		}
		raw, _ := json.Marshal(meta)
		var trashedAt any
		if trashed {
			trashedAt = "2026-11-24T10:00:00Z"
		}
		noteType, place := any("class"), any("app")
		if kind == "folder" {
			noteType, place = nil, nil
		}
		if _, err := h.db.Exec(`INSERT INTO library_items (user_id, id, item_kind, note_type, name, folder_id, place, position, meta, created_at, updated_at, trashed_at, rev, seq) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 1, 1)`,
			userID, id, kind, noteType, name, orNull(folder), place, string(raw), created, created, trashedAt); err != nil {
			t.Fatal(err)
		}
	}
	put("vp6", "folder", "VP6", "", "2026-11-01T10:00:00Z", false)
	put("hm-a", "folder", "HM", "vp6", "2026-11-02T10:00:00Z", false)
	put("hm-b", "folder", "hm ", "vp6", "2026-11-03T10:00:00Z", false)
	put("hm-lixo", "folder", "HM", "vp6", "2026-11-01T09:00:00Z", true)
	put("aulas-a", "folder", "Aulas", "hm-a", "2026-11-02T11:00:00Z", false)
	put("aulas-b", "folder", "aulas", "hm-b", "2026-11-03T11:00:00Z", false)
	put("resumo-a", "file", "Resumo", "hm-a", "2026-11-02T12:00:00Z", false)
	put("resumo-b", "file", "Resumo", "hm-b", "2026-11-03T12:00:00Z", false)
	put("outra", "file", "Outra", "hm-b", "2026-11-03T13:00:00Z", false)
	put("aula1-a", "file", "Aula 1", "aulas-a", "2026-11-02T13:00:00Z", false)
	put("aula1-b", "file", "aula 1", "aulas-b", "2026-11-03T14:00:00Z", false)
	put("plano-1", "file", "Plano", "", "2026-11-01T10:00:00Z", false)
	put("plano-2", "file", "Plano", "", "2026-11-05T10:00:00Z", false)
	put("plano-3", "file", "Plano (2)", "", "2026-11-04T10:00:00Z", false)
	// as on the real database: the account's count of changes is at least the rows' seq
	if _, err := h.db.Exec(`UPDATE user SET seq = 1 WHERE id = ?`, userID); err != nil {
		t.Fatal(err)
	}

	// simulating changes nothing and says what would change
	simulated, err := RepairNames(context.Background(), h.db, h.now, userID, false)
	if err != nil {
		t.Fatal(err)
	}
	if simulated.FoldersJoined != 2 || simulated.NotesRenamed != 3 {
		t.Fatalf("simulated: %+v", simulated)
	}
	var untouched int
	h.db.QueryRow(`SELECT COUNT(*) FROM library_items WHERE user_id = ? AND rev = 1`, userID).Scan(&untouched)
	if untouched != 14 {
		t.Fatalf("simulating changed %d rows", 14-untouched)
	}

	report, err := RepairNames(context.Background(), h.db, h.now, userID, true)
	if err != nil {
		t.Fatal(err)
	}
	if report.FoldersJoined != 2 || report.NotesRenamed != 3 {
		t.Fatalf("report: %+v", report)
	}
	type item struct {
		name, folder string
		trashed      bool
		rev          int
		meta         map[string]any
	}
	read := func(id string) item {
		t.Helper()
		var out item
		var folder, trashedAt *string
		var meta string
		if err := h.db.QueryRow(`SELECT name, folder_id, trashed_at, rev, meta FROM library_items WHERE user_id = ? AND id = ?`, userID, id).Scan(&out.name, &folder, &trashedAt, &out.rev, &meta); err != nil {
			t.Fatal(err)
		}
		if folder != nil {
			out.folder = *folder
		}
		out.trashed = trashedAt != nil && *trashedAt != ""
		_ = json.Unmarshal([]byte(meta), &out.meta)
		return out
	}
	// the newer HM went to the Trash and what it had is in the oldest; the Aulas inside them joined too
	if got := read("hm-b"); !got.trashed || got.meta["deletedAt"] == nil || got.rev != 2 {
		t.Fatalf("hm-b: %+v", got)
	}
	if got := read("aulas-b"); !got.trashed || got.folder != "hm-a" {
		t.Fatalf("aulas-b: %+v", got)
	}
	if got := read("outra"); got.folder != "hm-a" || got.meta["folderId"] != "hm-a" || got.name != "Outra" {
		t.Fatalf("outra: %+v", got)
	}
	// the oldest note keeps the name; the newer gets " (2)", in the column and in the meta the app reads
	if got := read("resumo-a"); got.name != "Resumo" || got.rev != 1 {
		t.Fatalf("resumo-a: %+v", got)
	}
	if got := read("resumo-b"); got.name != "Resumo (2)" || got.folder != "hm-a" || got.meta["name"] != "Resumo (2)" || got.meta["folderId"] != "hm-a" {
		t.Fatalf("resumo-b: %+v", got)
	}
	if got := read("aula1-b"); got.name != "aula 1 (2)" || got.folder != "aulas-a" {
		t.Fatalf("aula1-b: %+v", got)
	}
	// " (2)" already taken at the root: the newer Plano gets " (3)"; the one in the Trash is left alone
	if got := read("plano-2"); got.name != "Plano (3)" {
		t.Fatalf("plano-2: %+v", got)
	}
	if got := read("hm-lixo"); got.rev != 1 {
		t.Fatalf("what is in the Trash changed: %+v", got)
	}
	// the devices get it by the map: every row changed has the same new seq
	var changed int
	h.db.QueryRow(`SELECT COUNT(*) FROM library_items WHERE user_id = ? AND seq > 1`, userID).Scan(&changed)
	// hm-b, aulas-b, resumo-b, outra, aula1-b and plano-2
	if changed != 6 {
		t.Fatalf("rows on the map: %d", changed)
	}

	// once is enough: a second run changes nothing
	again, err := RepairNames(context.Background(), h.db, h.now, userID, true)
	if err != nil || again.FoldersJoined != 0 || again.NotesRenamed != 0 {
		t.Fatalf("second run: %+v %v", again, err)
	}
}

func orNull(value string) any {
	if value == "" {
		return nil
	}
	return value
}
