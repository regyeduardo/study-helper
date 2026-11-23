package server

import (
	"net/http"
	"strings"
	"testing"
	"time"
)

// Spec 005 (T007, contracts/api-hierarquia.md): the copy of the hierarchy of before the migration (FR-014), the end of the
// migration with the count checked (FR-016) and user.hierarchyAt in /v1/me.

func snapshot() map[string]any {
	return map[string]any{"snapshot": map[string]any{
		"folders": []any{map[string]any{"id": "f1", "name": "Faculdade"}, map[string]any{"id": "f2", "name": "Cálculo", "parentId": "f1"}},
		"files": []any{
			map[string]any{"id": "n1", "name": "Aula", "place": "drive", "sourceExcerpt": "texto da origem", "source": map[string]any{"kind": "pdf", "text": "texto inteiro"}},
			map[string]any{"id": "n2", "name": "Kickoff", "place": "app"},
			map[string]any{"id": "n3", "name": "Rascunho", "place": "local"},
		},
	}}
}

func hierarchyAt(t *testing.T, h *harness, client *http.Client) any {
	t.Helper()
	res, body := h.do(client, call{path: "/v1/me"})
	user, _ := body["user"].(map[string]any)
	value, has := user["hierarchyAt"]
	if res.StatusCode != 200 || !has {
		t.Fatalf("me without hierarchyAt: %d %v", res.StatusCode, body)
	}
	return value
}

func TestHierarchyBackup(t *testing.T) {
	h := newHarness(t)
	ana, anaID := h.account("no-code", false, "ana@exemplo.com")
	if at := hierarchyAt(t, h, ana); at != nil {
		t.Fatalf("hierarchyAt before the migration: %v", at)
	}

	res, body := h.do(ana, call{method: http.MethodPost, path: "/v1/library/hierarchy/backup", body: snapshot()})
	id, _ := body["id"].(string)
	if res.StatusCode != 201 || id == "" || num(body["folders"]) != 2 || num(body["files"]) != 3 {
		t.Fatalf("backup: %d %v", res.StatusCode, body)
	}
	var stored string
	if err := h.db.QueryRow(`SELECT snapshot FROM hierarchy_backups WHERE user_id = ? AND id = ?`, anaID, id).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(stored, "texto da origem") || strings.Contains(stored, "texto inteiro") || !strings.Contains(stored, "Rascunho") {
		t.Fatalf("the copy keeps the hierarchy, never the text: %s", stored)
	}

	// again before hierarchyAt: the same copy, nothing doubled
	again := snapshot()
	again["snapshot"].(map[string]any)["folders"] = []any{}
	res, body = h.do(ana, call{method: http.MethodPost, path: "/v1/library/hierarchy/backup", body: again})
	if res.StatusCode != 200 || body["id"] != id || num(body["folders"]) != 2 || num(body["files"]) != 3 {
		t.Fatalf("backup again: %d %v", res.StatusCode, body)
	}
	var copies int
	_ = h.db.QueryRow(`SELECT COUNT(*) FROM hierarchy_backups WHERE user_id = ?`, anaID).Scan(&copies)
	if copies != 1 {
		t.Fatalf("copies: %d", copies)
	}

	bia, _ := h.account("enabled", true, "bia@exemplo.com")
	big := `{"snapshot":{"folders":[],"files":[{"id":"n1","name":"` + strings.Repeat("a", 4<<20) + `"}]}}`
	if res, out := h.raw(bia, http.MethodPost, "/v1/library/hierarchy/backup", []byte(big), map[string]string{"Content-Type": "application/json"}); res.StatusCode != 413 || !strings.Contains(string(out), `"too_large"`) {
		t.Fatalf("above 4 MiB: %d %.200s", res.StatusCode, out)
	}
	for name, wrong := range map[string]any{"no snapshot": map[string]any{}, "no files": map[string]any{"snapshot": map[string]any{"folders": []any{}}}, "not a list": map[string]any{"snapshot": map[string]any{"folders": []any{}, "files": "x"}}} {
		if res, body := h.do(bia, call{method: http.MethodPost, path: "/v1/library/hierarchy/backup", body: wrong}); res.StatusCode != 400 || body["error"] != "invalid_body" {
			t.Errorf("%s: %d %v", name, res.StatusCode, body)
		}
	}
	if res, _ := h.do(h.browser(), call{method: http.MethodPost, path: "/v1/library/hierarchy/backup", body: snapshot()}); res.StatusCode != 401 {
		t.Fatalf("no session: %d", res.StatusCode)
	}
}

func TestHierarchyDone(t *testing.T) {
	h := newHarness(t)
	ana, _ := h.account("no-code", false, "ana@exemplo.com")
	res, body := h.do(ana, call{method: http.MethodPost, path: "/v1/library/hierarchy/backup", body: snapshot()})
	backup, _ := body["id"].(string)
	if res.StatusCode != 201 || backup == "" {
		t.Fatalf("backup: %d %v", res.StatusCode, body)
	}
	put := func(id string, fields map[string]any) {
		t.Helper()
		if res, body := h.do(ana, call{method: http.MethodPut, path: "/v1/library/items/" + id, body: map[string]any{"baseRev": 0, "row": fields}}); res.StatusCode != 200 {
			t.Fatalf("put %s: %d %v", id, res.StatusCode, body)
		}
	}
	put("f1", folder("Faculdade", nil))
	put("f2", folder("Cálculo", map[string]any{"folderId": "f1"}))
	put("n1", row("Aula", map[string]any{"place": "drive", "folderId": "f2"}))
	put("n2", row("Kickoff", map[string]any{"place": "drive"}))
	// in the Trash still counts; deleted for good does not
	put("n3", row("Na Lixeira", map[string]any{"place": "drive", "trashedAt": "2026-11-23T10:00:00Z"}))
	put("n4", row("Apagada", map[string]any{"place": "drive"}))
	if res, _ := h.do(ana, call{method: http.MethodDelete, path: "/v1/library/items/n4?baseRev=1"}); res.StatusCode != 200 {
		t.Fatalf("delete: %d", res.StatusCode)
	}

	res, body = h.do(ana, call{method: http.MethodPost, path: "/v1/library/hierarchy/done", body: map[string]any{"backupId": backup, "folders": 2, "files": 2}})
	if res.StatusCode != 409 || body["error"] != "count_mismatch" || num(body["folders"]) != 2 || num(body["files"]) != 3 {
		t.Fatalf("count mismatch: %d %v", res.StatusCode, body)
	}
	if at := hierarchyAt(t, h, ana); at != nil {
		t.Fatalf("a mismatch marked the migration: %v", at)
	}
	if res, body := h.do(ana, call{method: http.MethodPost, path: "/v1/library/hierarchy/done", body: map[string]any{"backupId": "nada", "folders": 2, "files": 3}}); res.StatusCode != 404 || body["error"] != "backup_not_found" {
		t.Fatalf("unknown backup: %d %v", res.StatusCode, body)
	}

	res, body = h.do(ana, call{method: http.MethodPost, path: "/v1/library/hierarchy/done", body: map[string]any{"backupId": backup, "folders": 2, "files": 3}})
	done, _ := body["hierarchyAt"].(string)
	if res.StatusCode != 200 || done == "" {
		t.Fatalf("done: %d %v", res.StatusCode, body)
	}
	if _, err := time.Parse(time.RFC3339Nano, done); err != nil {
		t.Fatalf("hierarchyAt is not ISO-8601: %q", done)
	}
	if at := hierarchyAt(t, h, ana); at != done {
		t.Fatalf("me: hierarchyAt %v, want %s", at, done)
	}

	// again, later, even with other counts: the same answer
	h.now = h.now.Add(time.Hour)
	res, body = h.do(ana, call{method: http.MethodPost, path: "/v1/library/hierarchy/done", body: map[string]any{"backupId": backup, "folders": 0, "files": 0}})
	if res.StatusCode != 200 || body["hierarchyAt"] != done {
		t.Fatalf("done again: %d %v", res.StatusCode, body)
	}

	// another account: its own migration, and no one else's copy
	bia, _ := h.account("enabled", true, "bia@exemplo.com")
	if at := hierarchyAt(t, h, bia); at != nil {
		t.Fatalf("another account was marked: %v", at)
	}
	if res, body := h.do(bia, call{method: http.MethodPost, path: "/v1/library/hierarchy/done", body: map[string]any{"backupId": backup, "folders": 0, "files": 0}}); res.StatusCode != 404 {
		t.Fatalf("another account's backup: %d %v", res.StatusCode, body)
	}
}
