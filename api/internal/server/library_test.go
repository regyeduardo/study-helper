package server

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// Entrega 4 (spec 003, história 2, T062–T066): the library map, the parts in versions, the index, the uploads in parts, the media,
// the live channel, the space and the cleaning. Contracts api-biblioteca.md and api-arquivos.md, English names of data-model.md.

func row(name string, extra map[string]any) map[string]any {
	out := map[string]any{"itemKind": "file", "noteType": "class", "name": name, "place": "app", "position": 1, "meta": map[string]any{"name": name, "sourceExcerpt": "texto da origem", "courseMaterial": "material"}, "createdAt": "2026-11-21T10:00:00Z", "updatedAt": "2026-11-21T10:00:00Z"}
	for key, value := range extra {
		out[key] = value
	}
	return out
}

func num(value any) int64 {
	n, _ := value.(float64)
	return int64(n)
}

func TestLibraryMapRows(t *testing.T) {
	h := newHarness(t)
	ana, _ := h.account("enabled", true, "ana@exemplo.com")

	res, body := h.do(ana, call{method: http.MethodPut, path: "/v1/library/items/n1", body: map[string]any{"baseRev": 0, "row": row("Aula", nil)}})
	if res.StatusCode != 200 || num(body["rev"]) != 1 || num(body["seq"]) != 1 {
		t.Fatalf("create: %d %v", res.StatusCode, body)
	}
	res, body = h.do(ana, call{path: "/v1/library/map?since=0"})
	rows := body["rows"].([]any)
	first := rows[0].(map[string]any)
	meta := first["meta"].(map[string]any)
	if res.StatusCode != 200 || len(rows) != 1 || first["name"] != "Aula" || meta["sourceExcerpt"] != nil || meta["courseMaterial"] != nil || num(body["seq"]) != 1 || body["more"] != false {
		t.Fatalf("map: %d %v", res.StatusCode, body)
	}

	// a write based on an old rev gets the current row back
	res, body = h.do(ana, call{method: http.MethodPut, path: "/v1/library/items/n1", body: map[string]any{"baseRev": 0, "row": row("Aula outra", nil)}})
	if res.StatusCode != 409 || body["error"] != "conflict" || num(body["current"].(map[string]any)["rev"]) != 1 {
		t.Fatalf("stale write: %d %v", res.StatusCode, body)
	}
	res, body = h.do(ana, call{method: http.MethodPut, path: "/v1/library/items/n1", body: map[string]any{"baseRev": 1, "row": row("Aula 2", map[string]any{"parts": map[string]any{"text": "inventado"}, "noteBytes": 999})}})
	if res.StatusCode != 200 || num(body["rev"]) != 2 {
		t.Fatalf("update: %d %v", res.StatusCode, body)
	}
	_, body = h.do(ana, call{path: "/v1/library/items/n1"})
	if body["name"] != "Aula 2" || len(body["parts"].(map[string]any)) != 0 || num(body["noteBytes"]) != 0 {
		t.Fatalf("the app cannot write parts nor sizes: %v", body)
	}

	// a mother of its own mother
	h.do(ana, call{method: http.MethodPut, path: "/v1/library/items/n2", body: map[string]any{"baseRev": 0, "row": row("Filha", map[string]any{"parentFileId": "n1"})}})
	res, body = h.do(ana, call{method: http.MethodPut, path: "/v1/library/items/n1", body: map[string]any{"baseRev": 2, "row": row("Aula 2", map[string]any{"parentFileId": "n2"})}})
	if res.StatusCode != 422 || body["error"] != "cycle" {
		t.Fatalf("cycle: %d %v", res.StatusCode, body)
	}

	// a batch is all or nothing
	res, body = h.do(ana, call{method: http.MethodPost, path: "/v1/library/items/batch", body: map[string]any{"operations": []any{
		map[string]any{"id": "n1", "baseRev": 2, "row": row("Aula 3", nil)},
		map[string]any{"id": "n2", "baseRev": 7, "row": row("Filha 2", nil)},
	}}})
	if res.StatusCode != 409 || len(body["currents"].([]any)) != 1 {
		t.Fatalf("stale batch: %d %v", res.StatusCode, body)
	}
	_, body = h.do(ana, call{path: "/v1/library/items/n1"})
	if body["name"] != "Aula 2" {
		t.Fatalf("a refused batch changed a row: %v", body)
	}
	trashed := "2026-11-21T11:00:00Z"
	res, body = h.do(ana, call{method: http.MethodPost, path: "/v1/library/items/batch", body: map[string]any{"operations": []any{
		map[string]any{"id": "n1", "baseRev": 2, "row": row("Aula 2", map[string]any{"trashedAt": trashed, "trashedWith": "n1"})},
		map[string]any{"id": "n2", "baseRev": 1, "row": row("Filha", map[string]any{"parentFileId": "n1", "trashedAt": trashed, "trashedWith": "n1"})},
	}}})
	if res.StatusCode != 200 || num(body["revs"].(map[string]any)["n1"]) != 3 {
		t.Fatalf("batch: %d %v", res.StatusCode, body)
	}

	// only what changed, page by page
	_, body = h.do(ana, call{path: "/v1/library/map?since=3&limit=1"})
	if len(body["rows"].([]any)) != 1 || body["more"] != true {
		t.Fatalf("first page: %v", body)
	}

	// deleted for good: a tombstone for the other devices
	res, body = h.do(ana, call{method: http.MethodDelete, path: "/v1/library/items/n2?baseRev=2"})
	if res.StatusCode != 200 {
		t.Fatalf("delete: %d %v", res.StatusCode, body)
	}
	_, body = h.do(ana, call{path: "/v1/library/items/n2"})
	if body["removedAt"] == nil {
		t.Fatalf("no tombstone: %v", body)
	}

	// another account sees nothing; spec 005: an account with the structure off uses the map too (its own, empty here)
	bia, _ := h.account("enabled", true, "bia@exemplo.com")
	if res, _ := h.do(bia, call{path: "/v1/library/items/n1"}); res.StatusCode != 404 {
		t.Fatalf("another account read a row: %d", res.StatusCode)
	}
	off, _ := h.account("enabled", false, "carla@exemplo.com")
	if res, body := h.do(off, call{path: "/v1/library/map?since=0"}); res.StatusCode != 200 || len(body["rows"].([]any)) != 0 {
		t.Fatalf("structure off: %d %v", res.StatusCode, body)
	}
}

// Spec 005, FR-021 (25/11: "no mesmo diretório não pode existir nem pasta de nome igual nem arquivo"): in one folder, the root too, no
// two folders and no two notes with the same name (capitals and the spaces at the ends do not tell them apart; the Trash does not
// count; a folder and a note may share a name). The server refuses it even when an old app asks; a pair that existed before the rule
// still takes its other changes (T052 joins them).
func TestNamesAreUniqueInAFolder(t *testing.T) {
	h := newHarness(t)
	ana, _ := h.account("enabled", true, "ana@exemplo.com")
	put := func(id string, base int, fields map[string]any) (int, map[string]any) {
		res, body := h.do(ana, call{method: http.MethodPut, path: "/v1/library/items/" + id, body: map[string]any{"baseRev": base, "row": fields}})
		return res.StatusCode, body
	}
	folder := func(name string, extra map[string]any) map[string]any {
		out := map[string]any{"itemKind": "folder", "name": name, "position": 0, "meta": map[string]any{"name": name}, "createdAt": "2026-11-25T10:00:00Z", "updatedAt": "2026-11-25T10:00:00Z"}
		for key, value := range extra {
			out[key] = value
		}
		return out
	}
	in := func(folderID string, extra map[string]any) map[string]any {
		out := map[string]any{"folderId": folderID}
		for key, value := range extra {
			out[key] = value
		}
		return out
	}
	ok := func(what string, status int, body map[string]any) {
		t.Helper()
		if status != 200 {
			t.Fatalf("%s: %d %v", what, status, body)
		}
	}
	taken := func(what string, status int, body map[string]any, name string) {
		t.Helper()
		if status != 409 || body["error"] != "name_taken" || body["taken"].(map[string]any)["name"] != name {
			t.Fatalf("%s: %d %v", what, status, body)
		}
	}

	status, body := put("vp6", 0, folder("VP6", nil))
	ok("VP6", status, body)
	status, body = put("hm", 0, folder("HM", in("vp6", nil)))
	ok("HM", status, body)
	status, body = put("hm2", 0, folder(" hm ", in("vp6", nil)))
	taken("another HM in VP6", status, body, "HM")
	status, body = put("hm-root", 0, folder("HM", nil))
	ok("HM at the root", status, body)
	status, body = put("n-hm", 0, row("HM", in("vp6", nil)))
	ok("a note named as a folder", status, body)

	status, body = put("n1", 0, row("Resumo", in("vp6", nil)))
	ok("Resumo", status, body)
	status, body = put("n2", 0, row("RESUMO", in("vp6", nil)))
	taken("another Resumo", status, body, "Resumo")
	status, body = put("n3", 0, row("Outro", in("vp6", nil)))
	ok("Outro", status, body)
	status, body = put("n3", 1, row("resumo ", in("vp6", nil)))
	taken("renamed to Resumo", status, body, "Resumo")
	status, body = put("n1", 1, row("Resumo", in("vp6", map[string]any{"position": 5})))
	ok("the same note, other changes", status, body)
	status, body = put("n4", 0, row("Resumo", in("hm", nil)))
	ok("Resumo in HM", status, body)
	status, body = put("n4", 1, row("Resumo", in("vp6", nil)))
	taken("moved into VP6", status, body, "Resumo")

	// the Trash does not count; coming back over a live one is refused
	status, body = put("n1", 2, row("Resumo", in("vp6", map[string]any{"trashedAt": "2026-11-25T12:00:00Z"})))
	ok("Resumo to the Trash", status, body)
	status, body = put("n2", 0, row("RESUMO", in("vp6", nil)))
	ok("RESUMO now", status, body)
	status, body = put("n1", 3, row("Resumo", in("vp6", nil)))
	taken("back from the Trash", status, body, "RESUMO")

	// a batch with one repeated name changes nothing
	res, batch := h.do(ana, call{method: http.MethodPost, path: "/v1/library/items/batch", body: map[string]any{"operations": []any{
		map[string]any{"id": "n3", "baseRev": 1, "row": row("Terceira", in("vp6", nil))},
		map[string]any{"id": "n4", "baseRev": 1, "row": row("Resumo", in("vp6", nil))},
	}}})
	if res.StatusCode != 409 || batch["error"] != "name_taken" {
		t.Fatalf("batch: %d %v", res.StatusCode, batch)
	}
	if _, got := h.do(ana, call{path: "/v1/library/items/n3"}); got["name"] != "Outro" {
		t.Fatalf("a refused batch changed a row: %v", got)
	}

	// a pair from before the rule still takes its other changes
	var userID string
	if err := h.db.QueryRow(`SELECT id FROM user WHERE email = ?`, "ana@exemplo.com").Scan(&userID); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"d1", "d2"} {
		if _, err := h.db.Exec(`INSERT INTO library_items (user_id, id, item_kind, note_type, name, folder_id, place, position, meta, created_at, updated_at, rev, seq) VALUES (?, ?, 'file', 'class', 'Velha', 'vp6', 'app', 0, '{}', '2026-11-20T10:00:00Z', '2026-11-20T10:00:00Z', 1, 0)`, userID, id); err != nil {
			t.Fatal(err)
		}
	}
	status, body = put("d2", 1, row("Velha", in("vp6", map[string]any{"position": 3})))
	ok("an old pair, other changes", status, body)
}

func TestLibraryPartsAndIndex(t *testing.T) {
	h := newHarness(t)
	ana, _ := h.account("enabled", true, "ana@exemplo.com")
	h.do(ana, call{method: http.MethodPut, path: "/v1/library/items/n1", body: map[string]any{"baseRev": 0, "row": row("Aula", nil)}})

	res, out := h.raw(ana, http.MethodPut, "/v1/library/items/n1/parts/text", []byte("# Aula\n"), map[string]string{"If-None-Match": "*", "Content-Type": "text/markdown"})
	var first map[string]any
	_ = json.Unmarshal(out, &first)
	v1, _ := first["version"].(string)
	if res.StatusCode != 200 || v1 == "" || num(first["bytes"]) != 7 {
		t.Fatalf("first version: %d %s", res.StatusCode, out)
	}
	res, out = h.raw(ana, http.MethodGet, "/v1/library/items/n1/parts/text", nil, nil)
	if res.StatusCode != 200 || string(out) != "# Aula\n" || res.Header.Get("ETag") != `"`+v1+`"` || !strings.Contains(res.Header.Get("Cache-Control"), "immutable") {
		t.Fatalf("read: %d %q %v", res.StatusCode, out, res.Header)
	}
	// someone else wrote first
	res, out = h.raw(ana, http.MethodPut, "/v1/library/items/n1/parts/text", []byte("outra"), map[string]string{"If-None-Match": "*"})
	if res.StatusCode != 409 || !strings.Contains(string(out), `"currentVersion":"`+v1+`"`) {
		t.Fatalf("conflict: %d %s", res.StatusCode, out)
	}
	res, out = h.raw(ana, http.MethodPut, "/v1/library/items/n1/parts/text", []byte("# Aula\nmais"), map[string]string{"If-Match": `"` + v1 + `"`})
	var second map[string]any
	_ = json.Unmarshal(out, &second)
	if res.StatusCode != 200 || second["version"] == v1 {
		t.Fatalf("second version: %d %s", res.StatusCode, out)
	}
	if res, out := h.raw(ana, http.MethodGet, "/v1/library/items/n1/parts/text?version="+v1, nil, nil); res.StatusCode != 200 || string(out) != "# Aula\n" {
		t.Fatalf("an old version is still readable: %d %q", res.StatusCode, out)
	}
	var orphans int
	_ = h.db.QueryRow(`SELECT COUNT(*) FROM orphans WHERE reason = 'replaced'`).Scan(&orphans)
	if orphans != 1 {
		t.Fatalf("the replaced version goes to orphans: %d", orphans)
	}
	_, me := h.do(ana, call{path: "/v1/me"})
	if num(me["space"].(map[string]any)["notes"]) != int64(len("# Aula\nmais")) {
		t.Fatalf("notes space: %v", me["space"])
	}

	// an artifact, then deleted
	h.raw(ana, http.MethodPut, "/v1/library/items/n1/parts/artifacts/a1", []byte(`{"id":"a1"}`), map[string]string{"If-None-Match": "*"})
	_, item := h.do(ana, call{path: "/v1/library/items/n1"})
	artifact, _ := item["parts"].(map[string]any)["artifacts/a1"].(string)
	if res, out := h.raw(ana, http.MethodDelete, "/v1/library/items/n1/parts/artifacts/a1", nil, map[string]string{"If-Match": `"` + artifact + `"`}); res.StatusCode != 200 {
		t.Fatalf("delete part: %d %s", res.StatusCode, out)
	}
	_, item = h.do(ana, call{path: "/v1/library/items/n1"})
	if _, still := item["parts"].(map[string]any)["artifacts/a1"]; still {
		t.Fatalf("part not deleted: %v", item["parts"])
	}
	if res, out := h.raw(ana, http.MethodPut, "/v1/library/items/n1/parts/segredos", []byte("x"), map[string]string{"If-None-Match": "*"}); res.StatusCode != 400 || !strings.Contains(string(out), "invalid_part") {
		t.Fatalf("a strange part name was taken: %d %s", res.StatusCode, out)
	}
	// T203: the photos of the screens marked while recording and the volume of each channel, apart from the note's own parts
	for _, part := range []string{"telas/000", "telas/12345", "volume"} {
		if res, out := h.raw(ana, http.MethodPut, "/v1/library/items/n1/parts/"+part, []byte(`{"at":1}`), map[string]string{"If-None-Match": "*"}); res.StatusCode != 200 {
			t.Fatalf("%s: %d %s", part, res.StatusCode, out)
		}
	}
	for _, part := range []string{"telas/abc", "telas/", "telas/1/2", "volumes"} {
		if res, _ := h.raw(ana, http.MethodPut, "/v1/library/items/n1/parts/"+part, []byte("x"), map[string]string{"If-None-Match": "*"}); res.StatusCode != 400 {
			t.Fatalf("%s was taken: %d", part, res.StatusCode)
		}
	}
	// ".." never reaches the handler: the router cleans the path and redirects
	if res, _ := h.raw(ana, http.MethodPut, "/v1/library/items/n1/parts/../secrets", []byte("x"), map[string]string{"If-None-Match": "*"}); res.StatusCode < 300 {
		t.Fatalf("a path with .. was taken: %d", res.StatusCode)
	}
	if res, _ := h.raw(ana, http.MethodPut, "/v1/library/items/nada/parts/text", []byte("x"), map[string]string{"If-None-Match": "*"}); res.StatusCode != 404 {
		t.Fatalf("part of a missing item: %d", res.StatusCode)
	}

	// text is never refused for space, and an item in the trash still saves (and says so)
	if _, err := h.db.Exec(`UPDATE user SET media_bytes = ? WHERE email = 'ana@exemplo.com'`, spaceLimit); err != nil {
		t.Fatal(err)
	}
	h.do(ana, call{method: http.MethodPut, path: "/v1/library/items/n1", body: map[string]any{"baseRev": 1, "row": row("Aula", map[string]any{"trashedAt": "2026-11-21T12:00:00Z"})}})
	_, item = h.do(ana, call{path: "/v1/library/items/n1"})
	current, _ := item["parts"].(map[string]any)["text"].(string)
	res, out = h.raw(ana, http.MethodPut, "/v1/library/items/n1/parts/text", []byte("ainda escrevo"), map[string]string{"If-Match": `"` + current + `"`})
	if res.StatusCode != 200 || !strings.Contains(string(out), `"inTrash":true`) {
		t.Fatalf("text in a full account, in the trash: %d %s", res.StatusCode, out)
	}

	// many parts at once
	res, out = h.raw(ana, http.MethodPost, "/v1/library/parts/batch", mustJSON(map[string]any{"requests": []any{
		map[string]any{"item": "n1", "part": "text", "version": v1},
		map[string]any{"item": "n1", "part": "exam", "version": "nada"},
	}}), map[string]string{"Content-Type": "application/json"})
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	if res.StatusCode != 200 || res.Header.Get("Content-Type") != "application/x-ndjson" || len(lines) != 2 || !strings.Contains(lines[0], `"content":"# Aula\n"`) || !strings.Contains(lines[1], `"error":"part_not_found"`) {
		t.Fatalf("batch: %d %v %q", res.StatusCode, res.Header, out)
	}

	// the index never carries an AI key
	res, out = h.raw(ana, http.MethodPut, "/v1/library/index", []byte(`{"settings":{"ai":{"apiKey":"sk-1"}},"tags":[]}`), map[string]string{"If-None-Match": "*"})
	if res.StatusCode != 422 || !strings.Contains(string(out), "key_in_index") {
		t.Fatalf("key in index: %d %s", res.StatusCode, out)
	}
	if res, _ := h.raw(ana, http.MethodGet, "/v1/library/index", nil, nil); res.StatusCode != 404 {
		t.Fatalf("no index yet: %d", res.StatusCode)
	}
	res, _ = h.raw(ana, http.MethodPut, "/v1/library/index", []byte(`{"settings":{"ai":{"apiKey":""}},"tags":["prova"]}`), map[string]string{"If-None-Match": "*"})
	if res.StatusCode != 200 {
		t.Fatalf("index: %d", res.StatusCode)
	}
	res, out = h.raw(ana, http.MethodGet, "/v1/library/index", nil, nil)
	if res.StatusCode != 200 || !strings.Contains(string(out), "prova") || res.Header.Get("ETag") == "" {
		t.Fatalf("read index: %d %s", res.StatusCode, out)
	}
}

func mustJSON(value any) []byte {
	out, _ := json.Marshal(value)
	return out
}

func TestUploadsAndMedia(t *testing.T) {
	h := newHarness(t)
	ana, anaID := h.account("enabled", true, "ana@exemplo.com")
	h.do(ana, call{method: http.MethodPut, path: "/v1/library/items/n1", body: map[string]any{"baseRev": 0, "row": row("Reunião", nil)}})
	start := map[string]any{"item": "n1", "media": "m1", "name": "Reunião 21-11.webm", "mime": "video/webm", "bytes": 10}

	res, body := h.do(ana, call{method: http.MethodPost, path: "/v1/uploads", body: start})
	upload, _ := body["upload"].(string)
	if res.StatusCode != 201 || upload == "" || num(body["partSize"]) != 4 || len(body["parts"].([]any)) != 0 {
		t.Fatalf("start: %d %v", res.StatusCode, body)
	}
	_, me := h.do(ana, call{path: "/v1/me"})
	if num(me["space"].(map[string]any)["reserved"]) != 10 {
		t.Fatalf("reserved: %v", me["space"])
	}
	_, item := h.do(ana, call{path: "/v1/library/items/n1"})
	if item["media"].(map[string]any)["status"] != "uploading" {
		t.Fatalf("media while uploading: %v", item["media"])
	}
	for n, part := range []string{"abcd", "efgh"} {
		if res, out := h.raw(ana, http.MethodPut, "/v1/uploads/"+upload+"/parts/"+itoa(n+1), []byte(part), nil); res.StatusCode != 200 {
			t.Fatalf("part %d: %d %s", n+1, res.StatusCode, out)
		}
	}
	// the same media again: the same upload, with the parts done (resume, maybe from another device)
	res, body = h.do(ana, call{method: http.MethodPost, path: "/v1/uploads", body: start})
	if res.StatusCode != 200 || body["upload"] != upload || len(body["parts"].([]any)) != 2 {
		t.Fatalf("resume: %d %v", res.StatusCode, body)
	}
	if res, out := h.raw(ana, http.MethodPut, "/v1/uploads/"+upload+"/parts/3", []byte("ijkl"), nil); res.StatusCode != 413 || !strings.Contains(string(out), "larger_than_declared") {
		t.Fatalf("larger than declared: %d %s", res.StatusCode, out)
	}
	h.raw(ana, http.MethodPut, "/v1/uploads/"+upload+"/parts/3", []byte("ij"), nil)
	res, body = h.do(ana, call{method: http.MethodPost, path: "/v1/uploads/" + upload + "/complete"})
	if res.StatusCode != 200 || num(body["bytes"]) != 10 || body["mime"] != "video/webm" {
		t.Fatalf("complete: %d %v", res.StatusCode, body)
	}
	_, me = h.do(ana, call{path: "/v1/me"})
	space := me["space"].(map[string]any)
	if num(space["reserved"]) != 0 || num(space["media"]) != 10 {
		t.Fatalf("space after complete: %v", space)
	}

	// read with Range, as the player does
	res, out := h.raw(ana, http.MethodGet, "/v1/media/n1/m1", nil, map[string]string{"Range": "bytes=2-5"})
	if res.StatusCode != 206 || string(out) != "cdef" || res.Header.Get("Content-Range") != "bytes 2-5/10" || res.Header.Get("Content-Type") != "video/webm" {
		t.Fatalf("range: %d %q %v", res.StatusCode, out, res.Header)
	}
	if res, _ := h.raw(ana, http.MethodGet, "/v1/media/n1/m1", nil, map[string]string{"Range": "bytes=20-30"}); res.StatusCode != 416 {
		t.Fatalf("range beyond: %d", res.StatusCode)
	}
	res, out = h.raw(ana, http.MethodGet, "/v1/media/n1/m1?download=1", nil, nil)
	if res.StatusCode != 200 || string(out) != "abcdefghij" || res.Header.Get("Accept-Ranges") != "bytes" || !strings.Contains(res.Header.Get("Content-Disposition"), "attachment; filename*=UTF-8''Reuni%C3%A3o%2021-11.webm") {
		t.Fatalf("download: %d %q %v", res.StatusCode, out, res.Header)
	}

	// no space: nothing reserved
	if _, err := h.db.Exec(`UPDATE user SET media_bytes = ? WHERE id = ?`, spaceLimit-5, anaID); err != nil {
		t.Fatal(err)
	}
	h.do(ana, call{method: http.MethodPut, path: "/v1/library/items/n2", body: map[string]any{"baseRev": 0, "row": row("Outra", nil)}})
	res, body = h.do(ana, call{method: http.MethodPost, path: "/v1/uploads", body: map[string]any{"item": "n2", "media": "m2", "name": "a.webm", "mime": "audio/webm", "bytes": 9}})
	if res.StatusCode != 413 || body["error"] != "no_space" || num(body["missing"]) != 4 || num(body["free"]) != 5 {
		t.Fatalf("no space: %d %v", res.StatusCode, body)
	}
	if res, body := h.do(ana, call{method: http.MethodPost, path: "/v1/uploads", body: map[string]any{"item": "n2", "media": "m2", "name": "a.exe", "mime": "application/x-msdownload", "bytes": 1}}); res.StatusCode != 415 || body["error"] != "type_refused" {
		t.Fatalf("type refused: %d %v", res.StatusCode, body)
	}

	// giving up frees the reservation and the storage's half-upload
	_, _ = h.db.Exec(`UPDATE user SET media_bytes = 10 WHERE id = ?`, anaID)
	_, body = h.do(ana, call{method: http.MethodPost, path: "/v1/uploads", body: map[string]any{"item": "n2", "media": "m2", "name": "a.webm", "mime": "audio/webm", "bytes": 3}})
	second := body["upload"].(string)
	if res, _ := h.do(ana, call{method: http.MethodDelete, path: "/v1/uploads/" + second}); res.StatusCode != 200 {
		t.Fatalf("abandon: %d", res.StatusCode)
	}
	_, me = h.do(ana, call{path: "/v1/me"})
	_, item = h.do(ana, call{path: "/v1/library/items/n2"})
	if num(me["space"].(map[string]any)["reserved"]) != 0 || item["media"] != nil || h.blobs.OpenUploads() != 0 {
		t.Fatalf("after giving up: %v %v %d", me["space"], item["media"], h.blobs.OpenUploads())
	}

	// deleting the media keeps the note, marked
	if res, _ := h.do(ana, call{method: http.MethodDelete, path: "/v1/media/n1/m1"}); res.StatusCode != 200 {
		t.Fatalf("delete media: %d", res.StatusCode)
	}
	if res, out := h.raw(ana, http.MethodGet, "/v1/media/n1/m1", nil, nil); res.StatusCode != 410 || !strings.Contains(string(out), "media_deleted") {
		t.Fatalf("deleted media: %d %s", res.StatusCode, out)
	}
	_, me = h.do(ana, call{path: "/v1/me"})
	if num(me["space"].(map[string]any)["media"]) != 0 {
		t.Fatalf("media space after deleting: %v", me["space"])
	}
}

func itoa(n int) string {
	out, _ := json.Marshal(n)
	return string(out)
}

func TestLiveChannel(t *testing.T) {
	h := newHarness(t)
	ana, _ := h.account("enabled", true, "ana@exemplo.com")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	wsURL := "ws" + strings.TrimPrefix(h.api.URL, "http") + "/v1/live"
	header := http.Header{"Origin": {appOrigin}}

	if _, res, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{HTTPClient: ana, HTTPHeader: http.Header{"Origin": {"https://evil.test"}}}); err == nil || res == nil || res.StatusCode != 403 {
		t.Fatalf("another site opened the channel: %v %v", err, res)
	}

	conn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{HTTPClient: ana, HTTPHeader: header})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	_ = conn.Write(ctx, websocket.MessageText, []byte(`{"type":"hello","seq":0}`))
	time.Sleep(50 * time.Millisecond)
	h.do(ana, call{method: http.MethodPut, path: "/v1/library/items/n1", body: map[string]any{"baseRev": 0, "row": row("Aula", nil)}})
	_, message, err := conn.Read(ctx)
	if err != nil || !strings.Contains(string(message), `"type":"map"`) || !strings.Contains(string(message), `"seq":1`) {
		t.Fatalf("a change reaches the channel: %s %v", message, err)
	}

	// a device that was away says what it has, and hears there is more
	h.do(ana, call{method: http.MethodPut, path: "/v1/library/items/n2", body: map[string]any{"baseRev": 0, "row": row("Outra", nil)}})
	late, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{HTTPClient: ana, HTTPHeader: header})
	if err != nil {
		t.Fatal(err)
	}
	defer late.CloseNow()
	_ = late.Write(ctx, websocket.MessageText, []byte(`{"type":"hello","seq":1}`))
	_, message, err = late.Read(ctx)
	if err != nil || !strings.Contains(string(message), `"seq":2`) {
		t.Fatalf("hello with an old seq: %s %v", message, err)
	}

	// the space goes too, after a part
	h.raw(ana, http.MethodPut, "/v1/library/items/n1/parts/text", []byte("abc"), map[string]string{"If-None-Match": "*"})
	sawSpace := false
	for i := 0; i < 4 && !sawSpace; i++ {
		_, message, err = late.Read(ctx)
		sawSpace = err == nil && strings.Contains(string(message), `"type":"space"`)
	}
	if !sawSpace {
		t.Fatal("no space message after a part")
	}
}

func TestSpaceCheckAndCleaning(t *testing.T) {
	h := newHarness(t)
	ana, anaID := h.account("enabled", true, "ana@exemplo.com")
	h.do(ana, call{method: http.MethodPut, path: "/v1/library/items/n1", body: map[string]any{"baseRev": 0, "row": row("Aula", nil)}})
	h.raw(ana, http.MethodPut, "/v1/library/items/n1/parts/text", []byte("12345"), map[string]string{"If-None-Match": "*"})
	h.raw(ana, http.MethodPut, "/v1/library/index", []byte(`{"tags":[]}`), map[string]string{"If-None-Match": "*"})

	// the stored total drifted: the daily check fixes it and writes down the difference
	if _, err := h.db.Exec(`UPDATE user SET notes_bytes = 999 WHERE id = ?`, anaID); err != nil {
		t.Fatal(err)
	}
	if err := h.srv.CheckUsage(context.Background()); err != nil {
		t.Fatal(err)
	}
	var notes, diff int64
	var checked *string
	_ = h.db.QueryRow(`SELECT notes_bytes, usage_diff, usage_checked_at FROM user WHERE id = ?`, anaID).Scan(&notes, &diff, &checked)
	if notes != 5+int64(len(`{"tags":[]}`)) || diff != 999-notes || checked == nil {
		t.Fatalf("check: notes %d diff %d checked %v", notes, diff, checked)
	}

	// orphans go away only after 31 days; open uploads after 7; tombstones after 60
	old := stamp(h.now.Add(-32 * 24 * time.Hour))
	recent := stamp(h.now.Add(-10 * 24 * time.Hour))
	_ = h.blobs.Put(context.Background(), "velho", []byte("x"), "", nil)
	_ = h.blobs.Put(context.Background(), "recente", []byte("x"), "", nil)
	_, _ = h.db.Exec(`INSERT INTO orphans (object_key, user_id, reason, since) VALUES ('velho', ?, 'replaced', ?), ('recente', ?, 'replaced', ?)`, anaID, old, anaID, recent)
	_, body := h.do(ana, call{method: http.MethodPost, path: "/v1/uploads", body: map[string]any{"item": "n1", "media": "m1", "name": "a.webm", "mime": "audio/webm", "bytes": 3}})
	upload := body["upload"].(string)
	_, _ = h.db.Exec(`UPDATE uploads SET updated_at = ? WHERE id = ?`, stamp(h.now.Add(-8*24*time.Hour)), upload)
	_, _ = h.db.Exec(`INSERT INTO library_items (user_id, id, item_kind, name, place, created_at, updated_at, removed_at, seq) VALUES (?, 'lapide', 'file', 'x', 'app', ?, ?, ?, 1)`, anaID, old, old, stamp(h.now.Add(-61*24*time.Hour)))
	if err := h.srv.Clean(context.Background()); err != nil {
		t.Fatal(err)
	}
	keys := strings.Join(h.blobs.Keys(), " ")
	if strings.Contains(keys, "velho") || !strings.Contains(keys, "recente") {
		t.Fatalf("orphans cleaned: %s", keys)
	}
	var status string
	var reserved, tombstones int64
	_ = h.db.QueryRow(`SELECT status FROM uploads WHERE id = ?`, upload).Scan(&status)
	_ = h.db.QueryRow(`SELECT reserved_bytes FROM user WHERE id = ?`, anaID).Scan(&reserved)
	_ = h.db.QueryRow(`SELECT COUNT(*) FROM library_items WHERE id = 'lapide'`).Scan(&tombstones)
	if status != "abandoned" || reserved != 0 || tombstones != 0 {
		t.Fatalf("cleaning: upload %s reserved %d tombstones %d", status, reserved, tombstones)
	}

	// the warning at 90% is the app's: the server says where it is
	_, me := h.do(ana, call{path: "/v1/me"})
	if me["space"].(map[string]any)["warnAt"] != 0.9 {
		t.Fatalf("warnAt: %v", me["space"])
	}
}
