package server

import (
	"encoding/json"
	"net/http"
	"testing"
)

// The live link of who uses the app structure (spec 003, história 7, FR-034 to FR-036, FR-063): nothing is copied nor sent again;
// the link points at the item, and whoever has it reads the item as it is now, with the media streamed straight from the App.

func putPart(t *testing.T, h *harness, client *http.Client, item, part, content string) {
	t.Helper()
	if res, out := h.raw(client, http.MethodPut, "/v1/library/items/"+item+"/parts/"+part, []byte(content), map[string]string{"If-None-Match": "*"}); res.StatusCode != 200 {
		t.Fatalf("part %s/%s: %d %s", item, part, res.StatusCode, out)
	}
}

func putRow(t *testing.T, h *harness, client *http.Client, id string, fields map[string]any) {
	t.Helper()
	if res, body := h.do(client, call{method: http.MethodPut, path: "/v1/library/items/" + id, body: map[string]any{"baseRev": 0, "row": fields}}); res.StatusCode != 200 {
		t.Fatalf("row %s: %d %v", id, res.StatusCode, body)
	}
}

// sharedFiles reads the public link as nobody (no session) and gives its notes by id.
func sharedFiles(t *testing.T, h *harness, id string) (int, map[string]any, map[string]map[string]any) {
	t.Helper()
	res, body := h.do(h.browser(), call{path: "/v1/shared/" + id})
	files := map[string]map[string]any{}
	if list, ok := body["files"].([]any); ok {
		for _, item := range list {
			file := item.(map[string]any)
			files[file["id"].(string)] = file
		}
	}
	return res.StatusCode, body, files
}

func partsOf(file map[string]any) map[string]any {
	parts, _ := file["parts"].(map[string]any)
	return parts
}

func TestLiveShareOfAnEntrada(t *testing.T) {
	h := newHarness(t)
	ana, _ := h.account("enabled", true, "ana@exemplo.com")
	// the entrada n1, a video kept in the App ("abcdefghij")
	storedMedia(t, h, ana)
	putPart(t, h, ana, "n1", "text", "texto da entrada")
	putPart(t, h, ana, "n1", "transcript", `{"recording":{"blocks":[{"speakerId":"s1","text":"oi"}]},"transcript":"Você [00:01]: oi"}`)
	putPart(t, h, ana, "n1", "exam", `{"questions":[{"id":"q1"}],"attempts":[{"id":"tentativa-da-ana"}]}`)
	// its notes: the Ata and the Descrição, a grandchild, one in the Lixeira, and one in the Google Drive
	putRow(t, h, ana, "ata", row("Ata", map[string]any{"noteType": "meeting", "parentFileId": "n1"}))
	putPart(t, h, ana, "ata", "text", "# Ata")
	putPart(t, h, ana, "ata", "artifacts/m1", `{"id":"m1","kind":"mapa","name":"Mapa","diagram":{"root":{"id":"r","label":"Raiz"}},"chat":[{"who":"user","text":"conversa da ana"}],"versions":[{"id":"v1"}]}`)
	putPart(t, h, ana, "ata", "artifacts/c1", `{"id":"c1","kind":"cartoes","name":"Cartões","cards":[{"id":"k1","front":"f","back":"v","box":3}]}`)
	putRow(t, h, ana, "desc", row("Descrição", map[string]any{"noteType": "explanation", "parentFileId": "n1"}))
	putPart(t, h, ana, "desc", "text", "# Descrição")
	putRow(t, h, ana, "neta", row("Neta", map[string]any{"noteType": "explanation", "parentFileId": "ata"}))
	putRow(t, h, ana, "lixo", row("No lixo", map[string]any{"parentFileId": "n1", "trashedAt": "2026-11-21T11:00:00Z", "trashedWith": "lixo"}))
	putRow(t, h, ana, "fora", row("Outra nota", nil))
	h.do(ana, call{method: http.MethodPut, path: "/v1/library/items/n1", body: map[string]any{"baseRev": 1, "row": row("Reunião", map[string]any{"noteType": "video"})}})

	// no link yet; sharing makes one, and sharing again gives the same one (any device: it is read from the account)
	if res, body := h.do(ana, call{path: "/v1/shares?item=n1"}); res.StatusCode != 404 || body["error"] != "no_link" {
		t.Fatalf("before sharing: %d %v", res.StatusCode, body)
	}
	res, made := h.do(ana, call{method: http.MethodPost, path: "/v1/shares", body: map[string]any{"item": "n1", "kind": "entrada"}})
	id, _ := made["id"].(string)
	if res.StatusCode != 201 || id == "" || made["live"] != true || made["kind"] != "entrada" || made["title"] != "Reunião" || made["createdAt"] == nil {
		t.Fatalf("share: %d %v", res.StatusCode, made)
	}
	if res, again := h.do(ana, call{method: http.MethodPost, path: "/v1/shares", body: map[string]any{"item": "n1", "kind": "entrada"}}); res.StatusCode != 200 || again["id"] != id {
		t.Fatalf("share again: %d %v", res.StatusCode, again)
	}
	if res, found := h.do(ana, call{path: "/v1/shares?item=n1"}); res.StatusCode != 200 || found["id"] != id || found["live"] != true {
		t.Fatalf("the link already made: %d %v", res.StatusCode, found)
	}

	// nobody signed in reads the entrada with every note born of it, as it is now
	status, body, files := sharedFiles(t, h, id)
	if status != 200 || body["kind"] != "entrada" || body["itemId"] != "n1" || body["title"] != "Reunião" || body["owner"].(map[string]any)["name"] != "Ana Teste" {
		t.Fatalf("public link: %d %v", status, body)
	}
	if len(files) != 4 || files["n1"] == nil || files["ata"] == nil || files["desc"] == nil || files["neta"] == nil {
		t.Fatalf("the family: %v", files)
	}
	if partsOf(files["desc"])["text"] != "# Descrição" || partsOf(files["ata"])["text"] != "# Ata" || partsOf(files["n1"])["text"] != "texto da entrada" {
		t.Fatalf("the notes' text: %v", files)
	}
	if partsOf(files["n1"])["transcript"] == nil {
		t.Fatalf("the transcription: %v", files["n1"])
	}
	// the exam goes with the entrada, never the sharer's attempts
	var exam map[string]any
	_ = json.Unmarshal([]byte(partsOf(files["n1"])["exam"].(string)), &exam)
	if len(exam["questions"].([]any)) != 1 || len(exam["attempts"].([]any)) != 0 {
		t.Fatalf("exam: %v", exam)
	}
	// the map goes without its conversation nor versions; the cards stay home
	ataParts := partsOf(files["ata"])
	if ataParts["artifacts/c1"] != nil || ataParts["artifacts/m1"] == nil {
		t.Fatalf("artifacts: %v", ataParts)
	}
	var mapa map[string]any
	_ = json.Unmarshal([]byte(ataParts["artifacts/m1"].(string)), &mapa)
	if mapa["chat"] != nil || mapa["versions"] != nil || mapa["diagram"] == nil {
		t.Fatalf("the map: %v", mapa)
	}
	media, _ := files["n1"]["media"].(map[string]any)
	if media == nil || media["mime"] != "video/webm" || num(media["bytes"]) != 10 || files["ata"]["media"] != nil {
		t.Fatalf("media: %v", files["n1"])
	}

	// the media plays from the App, in parts, without a session; only the media of a note of the link
	res, out := h.raw(h.browser(), http.MethodGet, "/v1/shared/"+id+"/media/n1", nil, map[string]string{"Range": "bytes=4-", "Origin": appOrigin})
	if res.StatusCode != 206 || string(out) != "efghij" || res.Header.Get("Content-Range") != "bytes 4-9/10" || res.Header.Get("Access-Control-Allow-Origin") != appOrigin {
		t.Fatalf("media of the link: %d %q %v", res.StatusCode, out, res.Header)
	}
	if res, _ := h.raw(h.browser(), http.MethodGet, "/v1/shared/"+id+"/media/fora", nil, nil); res.StatusCode != 404 {
		t.Fatalf("a note out of the link: %d", res.StatusCode)
	}

	// live: a note born after sharing and a new name are in the same link, with nothing else done
	putRow(t, h, ana, "nova", row("Nota nova", map[string]any{"noteType": "explanation", "parentFileId": "n1"}))
	h.do(ana, call{method: http.MethodPut, path: "/v1/library/items/n1", body: map[string]any{"baseRev": 2, "row": row("Reunião de segunda", map[string]any{"noteType": "video"})}})
	if _, body, files := sharedFiles(t, h, id); files["nova"] == nil || body["title"] != "Reunião de segunda" {
		t.Fatalf("not live: %v %v", body["title"], files)
	}

	// another account neither finds nor stops it; the owner stops it, and the link says so
	bia, _ := h.account("enabled", true, "bia@exemplo.com")
	if res, _ := h.do(bia, call{path: "/v1/shares?item=n1"}); res.StatusCode != 404 {
		t.Fatalf("another account found the link: %d", res.StatusCode)
	}
	if res, _ := h.do(bia, call{method: http.MethodDelete, path: "/v1/shares/" + id}); res.StatusCode != 404 {
		t.Fatalf("another account stopped the link: %d", res.StatusCode)
	}
	if res, body := h.do(ana, call{method: http.MethodDelete, path: "/v1/shares/" + id}); res.StatusCode != 200 {
		t.Fatalf("stop: %d %v", res.StatusCode, body)
	}
	if status, body, _ := sharedFiles(t, h, id); status != 410 || body["error"] != "share_stopped" {
		t.Fatalf("stopped link: %d %v", status, body)
	}
	if res, _ := h.raw(h.browser(), http.MethodGet, "/v1/shared/"+id+"/media/n1", nil, nil); res.StatusCode != 410 {
		t.Fatalf("media of a stopped link: %d", res.StatusCode)
	}
	if res, _ := h.do(ana, call{path: "/v1/shares?item=n1"}); res.StatusCode != 404 {
		t.Fatalf("a stopped link is not the item's link: %d", res.StatusCode)
	}
	// sharing again after stopping makes a new link
	if res, next := h.do(ana, call{method: http.MethodPost, path: "/v1/shares", body: map[string]any{"item": "n1", "kind": "entrada"}}); res.StatusCode != 201 || next["id"] == id {
		t.Fatalf("share after stopping: %d %v", res.StatusCode, next)
	}
	if status, _, _ := sharedFiles(t, h, "nao-existe"); status != 404 {
		t.Fatalf("unknown link: %d", status)
	}
}

func TestLiveShareRefusals(t *testing.T) {
	h := newHarness(t)
	ana, _ := h.account("enabled", true, "ana@exemplo.com")
	putRow(t, h, ana, "n1", row("Aula", nil))
	putRow(t, h, ana, "d1", row("No Drive", map[string]any{"place": "drive"}))

	// another account's item, an item that does not exist, a note in the Google Drive
	bia, _ := h.account("enabled", true, "bia@exemplo.com")
	if res, body := h.do(bia, call{method: http.MethodPost, path: "/v1/shares", body: map[string]any{"item": "n1", "kind": "file"}}); res.StatusCode != 404 || body["error"] != "not_found" {
		t.Fatalf("another account's item: %d %v", res.StatusCode, body)
	}
	if res, body := h.do(ana, call{method: http.MethodPost, path: "/v1/shares", body: map[string]any{"item": "d1", "kind": "file"}}); res.StatusCode != 422 || body["error"] != "not_in_app" {
		t.Fatalf("a note in the Drive: %d %v", res.StatusCode, body)
	}
	if res, body := h.do(ana, call{method: http.MethodPost, path: "/v1/shares", body: map[string]any{"item": "n1", "kind": "pasta"}}); res.StatusCode != 400 {
		t.Fatalf("unknown kind: %d %v", res.StatusCode, body)
	}
	// without the app structure, the link is the old one (share-worker)
	off, _ := h.account("enabled", false, "carla@exemplo.com")
	if res, _ := h.do(off, call{method: http.MethodPost, path: "/v1/shares", body: map[string]any{"item": "n1", "kind": "file"}}); res.StatusCode != 403 {
		t.Fatalf("structure off: %d", res.StatusCode)
	}

	// a note shared alone, then sent to the Lixeira: the link says the item is gone
	res, made := h.do(ana, call{method: http.MethodPost, path: "/v1/shares", body: map[string]any{"item": "n1", "kind": "file", "withExams": false, "artifacts": []string{"mapa"}}})
	id, _ := made["id"].(string)
	if res.StatusCode != 201 {
		t.Fatalf("share: %d %v", res.StatusCode, made)
	}
	putPart(t, h, ana, "n1", "exam", `{"questions":[{"id":"q1"}],"attempts":[]}`)
	if _, _, files := sharedFiles(t, h, id); partsOf(files["n1"])["exam"] != nil {
		t.Fatalf("the exam went without being chosen: %v", files["n1"])
	}
	h.do(ana, call{method: http.MethodPut, path: "/v1/library/items/n1", body: map[string]any{"baseRev": 1, "row": row("Aula", map[string]any{"trashedAt": "2026-11-21T11:00:00Z", "trashedWith": "n1"})}})
	if status, body, _ := sharedFiles(t, h, id); status != 410 || body["error"] != "item_removed" {
		t.Fatalf("item in the Lixeira: %d %v", status, body)
	}
}

func TestLiveShareOfAFolder(t *testing.T) {
	h := newHarness(t)
	ana, _ := h.account("enabled", true, "ana@exemplo.com")
	folder := func(name string, parent any) map[string]any {
		return map[string]any{"itemKind": "folder", "name": name, "folderId": parent, "position": 1, "meta": map[string]any{"name": name, "isCourse": false, "description": ""}, "createdAt": "2026-11-21T10:00:00Z", "updatedAt": "2026-11-21T10:00:00Z"}
	}
	putRow(t, h, ana, "f1", folder("Curso", nil))
	putRow(t, h, ana, "f2", folder("Módulo", "f1"))
	putRow(t, h, ana, "a1", row("Aula 1", map[string]any{"folderId": "f1"}))
	putRow(t, h, ana, "a2", row("Aula 2", map[string]any{"folderId": "f2"}))
	putRow(t, h, ana, "a3", row("Aula de fora", nil))
	putPart(t, h, ana, "a2", "text", "# Aula 2")

	res, made := h.do(ana, call{method: http.MethodPost, path: "/v1/shares", body: map[string]any{"item": "f1", "kind": "folder"}})
	if res.StatusCode != 201 {
		t.Fatalf("share folder: %d %v", res.StatusCode, made)
	}
	status, body, files := sharedFiles(t, h, made["id"].(string))
	folders, _ := body["folders"].([]any)
	if status != 200 || len(folders) != 2 || len(files) != 2 || files["a3"] != nil || partsOf(files["a2"])["text"] != "# Aula 2" {
		t.Fatalf("folder link: %d %v %v", status, folders, files)
	}
}
