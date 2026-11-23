package server

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// Spec 005 (T005, contracts/api-hierarquia.md): the map is the hierarchy of every signed-in account, with or without the app
// structure; only the content kept in the App (parts, uploads, media, index) needs the structure on. A folder has no place, a note
// has "app" or "drive", "app" only with the structure on, and placeOwn is gone.

func folder(name string, extra map[string]any) map[string]any {
	out := map[string]any{"itemKind": "folder", "name": name, "place": "drive", "placeOwn": true, "position": 1, "meta": map[string]any{"name": name}}
	for key, value := range extra {
		out[key] = value
	}
	return out
}

// noPlaceOwn fails when a row of an answer still carries placeOwn.
func noPlaceOwn(t *testing.T, rows ...any) {
	t.Helper()
	for _, item := range rows {
		if _, has := item.(map[string]any)["placeOwn"]; has {
			t.Errorf("placeOwn in an answer: %v", item)
		}
	}
}

func TestTheHierarchyNeedsOnlyASession(t *testing.T) {
	h := newHarness(t)
	for _, account := range []struct {
		status string
		app    bool
	}{{"no-code", false}, {"enabled", false}, {"enabled", true}} {
		client, _ := h.account(account.status, account.app, account.status+boolText(account.app)+"@exemplo.com")
		name := account.status + "/" + boolText(account.app)

		// a place sent on a folder is ignored
		if res, body := h.do(client, call{method: http.MethodPut, path: "/v1/library/items/f1", body: map[string]any{"baseRev": 0, "row": folder("Faculdade", nil)}}); res.StatusCode != 200 {
			t.Fatalf("%s: folder: %d %v", name, res.StatusCode, body)
		}
		note := row("Kickoff", map[string]any{"place": "drive", "driveRef": "drive-1", "folderId": "f1", "placeOwn": true})
		if res, body := h.do(client, call{method: http.MethodPut, path: "/v1/library/items/n1", body: map[string]any{"baseRev": 0, "row": note}}); res.StatusCode != 200 {
			t.Fatalf("%s: note in the Drive: %d %v", name, res.StatusCode, body)
		}
		res, body := h.do(client, call{path: "/v1/library/map?since=0"})
		if res.StatusCode != 200 || len(body["rows"].([]any)) != 2 {
			t.Fatalf("%s: map: %d %v", name, res.StatusCode, body)
		}
		noPlaceOwn(t, body["rows"].([]any)...)
		res, item := h.do(client, call{path: "/v1/library/items/f1"})
		if place, has := item["place"]; res.StatusCode != 200 || !has || place != nil {
			t.Fatalf("%s: a folder has no place: %d %v", name, res.StatusCode, item)
		}
		noPlaceOwn(t, item)
		_, item = h.do(client, call{path: "/v1/library/items/n1"})
		if item["place"] != "drive" || item["driveRef"] != "drive-1" {
			t.Fatalf("%s: note: %v", name, item)
		}
		res, body = h.do(client, call{method: http.MethodPost, path: "/v1/library/items/batch", body: map[string]any{"operations": []any{
			map[string]any{"id": "f1", "baseRev": 1, "row": folder("Faculdade 2", map[string]any{"place": "app"})},
			map[string]any{"id": "n1", "baseRev": 1, "row": row("Kickoff 2", map[string]any{"place": "drive", "folderId": "f1"})},
		}}})
		if res.StatusCode != 200 {
			t.Fatalf("%s: batch: %d %v", name, res.StatusCode, body)
		}
		if res, body := h.do(client, call{method: http.MethodDelete, path: "/v1/library/items/n1?baseRev=2"}); res.StatusCode != 200 {
			t.Fatalf("%s: delete: %d %v", name, res.StatusCode, body)
		}
	}
	var withPlace int
	_ = h.db.QueryRow(`SELECT COUNT(*) FROM library_items WHERE item_kind = 'folder' AND place IS NOT NULL`).Scan(&withPlace)
	if withPlace != 0 {
		t.Fatalf("%d folders kept a place", withPlace)
	}

	// an account whose access was taken away still cannot use it
	revoked, _ := h.account("revoked", false, "rita@exemplo.com")
	if res, body := h.do(revoked, call{path: "/v1/library/map?since=0"}); res.StatusCode != 403 || body["error"] != "access_revoked" {
		t.Fatalf("revoked: %d %v", res.StatusCode, body)
	}
	if res, _ := h.do(h.browser(), call{path: "/v1/library/map?since=0"}); res.StatusCode != 401 {
		t.Fatalf("no session: %d", res.StatusCode)
	}
}

func boolText(value bool) string {
	if value {
		return "on"
	}
	return "off"
}

func TestTheContentInTheAppStillNeedsTheStructure(t *testing.T) {
	h := newHarness(t)
	off, _ := h.account("enabled", false, "ana@exemplo.com")
	h.do(off, call{method: http.MethodPut, path: "/v1/library/items/n1", body: map[string]any{"baseRev": 0, "row": row("Aula", map[string]any{"place": "drive"})}})
	for _, c := range []struct {
		method, path string
		body         []byte
		headers      map[string]string
	}{
		{http.MethodGet, "/v1/library/items/n1/parts/text", nil, nil},
		{http.MethodPut, "/v1/library/items/n1/parts/text", []byte("# Aula"), map[string]string{"If-None-Match": "*"}},
		{http.MethodDelete, "/v1/library/items/n1/parts/text", nil, map[string]string{"If-Match": `"v1"`}},
		{http.MethodPost, "/v1/library/parts/batch", []byte(`{"requests":[]}`), nil},
		{http.MethodGet, "/v1/library/index", nil, nil},
		{http.MethodPut, "/v1/library/index", []byte(`{}`), map[string]string{"If-None-Match": "*"}},
		{http.MethodPost, "/v1/uploads", []byte(`{"item":"n1","media":"m1","name":"a.webm","mime":"audio/webm","bytes":3}`), nil},
		{http.MethodGet, "/v1/uploads/u1", nil, nil},
		{http.MethodGet, "/v1/media/n1/m1", nil, nil},
		{http.MethodDelete, "/v1/media/n1/m1", nil, nil},
	} {
		if res, out := h.raw(off, c.method, c.path, c.body, c.headers); res.StatusCode != 403 || !strings.Contains(string(out), `"app_disabled"`) {
			t.Errorf("%s %s without the structure: %d %s", c.method, c.path, res.StatusCode, out)
		}
	}
}

func TestANoteInTheAppNeedsTheStructureAndAPlaceMustBeKnown(t *testing.T) {
	h := newHarness(t)
	off, _ := h.account("no-code", false, "ana@exemplo.com")
	on, _ := h.account("enabled", true, "bia@exemplo.com")

	if res, body := h.do(off, call{method: http.MethodPut, path: "/v1/library/items/n1", body: map[string]any{"baseRev": 0, "row": row("Aula", nil)}}); res.StatusCode != 403 || body["error"] != "app_off" {
		t.Fatalf("a note in the App without the structure: %d %v", res.StatusCode, body)
	}
	if res, _ := h.do(off, call{path: "/v1/library/items/n1"}); res.StatusCode != 404 {
		t.Fatalf("a refused note was written: %d", res.StatusCode)
	}
	res, body := h.do(off, call{method: http.MethodPost, path: "/v1/library/items/batch", body: map[string]any{"operations": []any{
		map[string]any{"id": "n2", "baseRev": 0, "row": row("No Drive", map[string]any{"place": "drive"})},
		map[string]any{"id": "n3", "baseRev": 0, "row": row("No App", nil)},
	}}})
	if res.StatusCode != 403 || body["error"] != "app_off" {
		t.Fatalf("a batch with a note in the App without the structure: %d %v", res.StatusCode, body)
	}
	if res, _ := h.do(off, call{path: "/v1/library/items/n2"}); res.StatusCode != 404 {
		t.Fatalf("a refused batch wrote a row: %d", res.StatusCode)
	}
	if res, body := h.do(on, call{method: http.MethodPut, path: "/v1/library/items/n1", body: map[string]any{"baseRev": 0, "row": row("Aula", nil)}}); res.StatusCode != 200 {
		t.Fatalf("a note in the App with the structure: %d %v", res.StatusCode, body)
	}

	for _, client := range []*http.Client{off, on} {
		for name, place := range map[string]any{"Local": "local", "none": nil, "empty": ""} {
			res, body := h.do(client, call{method: http.MethodPut, path: "/v1/library/items/x1", body: map[string]any{"baseRev": 0, "row": row("Aula", map[string]any{"place": place})}})
			if res.StatusCode != 422 || body["error"] != "invalid_place" {
				t.Errorf("place %s: %d %v", name, res.StatusCode, body)
			}
		}
		// a folder needs no place at all
		if res, body := h.do(client, call{method: http.MethodPut, path: "/v1/library/items/f-sem", body: map[string]any{"baseRev": 0, "row": folder("Sem lugar", map[string]any{"place": nil})}}); res.StatusCode != 200 {
			t.Errorf("a folder without place: %d %v", res.StatusCode, body)
		}
	}
}

func TestTheHierarchyWorksWithoutTheStorage(t *testing.T) {
	h := newHarness(t)
	h.srv.cfg.Blobs = nil
	off, _ := h.account("no-code", false, "ana@exemplo.com")
	if res, body := h.do(off, call{method: http.MethodPut, path: "/v1/library/items/f1", body: map[string]any{"baseRev": 0, "row": folder("Faculdade", nil)}}); res.StatusCode != 200 {
		t.Fatalf("folder without the storage: %d %v", res.StatusCode, body)
	}
	if res, body := h.do(off, call{path: "/v1/library/map?since=0"}); res.StatusCode != 200 || len(body["rows"].([]any)) != 1 {
		t.Fatalf("map without the storage: %d %v", res.StatusCode, body)
	}
	if res, _ := h.do(off, call{method: http.MethodDelete, path: "/v1/library/items/f1?baseRev=1"}); res.StatusCode != 200 {
		t.Fatalf("delete without the storage: %d", res.StatusCode)
	}
	on, _ := h.account("enabled", true, "bia@exemplo.com")
	if res, out := h.raw(on, http.MethodGet, "/v1/library/index", nil, nil); res.StatusCode != 503 || !strings.Contains(string(out), "storage_unavailable") {
		t.Fatalf("content without the storage: %d %s", res.StatusCode, out)
	}
}

func TestTheLiveChannelNeedsOnlyASession(t *testing.T) {
	h := newHarness(t)
	off, _ := h.account("no-code", false, "ana@exemplo.com")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, res, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(h.api.URL, "http")+"/v1/live", &websocket.DialOptions{HTTPClient: off, HTTPHeader: http.Header{"Origin": {appOrigin}}})
	if err != nil {
		t.Fatalf("channel without the structure: %v %v", err, res)
	}
	defer conn.CloseNow()
	_ = conn.Write(ctx, websocket.MessageText, []byte(`{"type":"hello","seq":0}`))
	time.Sleep(50 * time.Millisecond)
	h.do(off, call{method: http.MethodPut, path: "/v1/library/items/f1", body: map[string]any{"baseRev": 0, "row": folder("Faculdade", nil)}})
	_, message, err := conn.Read(ctx)
	if err != nil || !strings.Contains(string(message), `"type":"map"`) {
		t.Fatalf("a change of the hierarchy reaches the channel: %s %v", message, err)
	}
}
