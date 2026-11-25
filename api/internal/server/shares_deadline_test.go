package server

import (
	"net/http"
	"strings"
	"testing"
	"time"
)

// The link with a deadline (spec 007, história 4, FR-031 to FR-041; contracts/api-shares.md): 1, 3 or 7 days, or Permanente (the
// default); the deadline changes without changing the address, an expired link shows nothing of the item (people, agents, media), and
// the list has every link with how long it has left.

func sharedNote(t *testing.T, h *harness) (*http.Client, string) {
	t.Helper()
	ana, userID := h.account("enabled", true, "ana@exemplo.com")
	storedMedia(t, h, ana)
	putPart(t, h, ana, "n1", "text", "texto da nota")
	return ana, userID
}

func share(t *testing.T, h *harness, client *http.Client, expiresIn string) map[string]any {
	t.Helper()
	body := map[string]any{"item": "n1", "kind": "file"}
	if expiresIn != "" {
		body["expiresIn"] = expiresIn
	}
	res, made := h.do(client, call{method: http.MethodPost, path: "/v1/shares", body: body})
	if res.StatusCode != 201 && res.StatusCode != 200 {
		t.Fatalf("share: %d %v", res.StatusCode, made)
	}
	return made
}

func TestShareDeadline(t *testing.T) {
	h := newHarness(t)
	ana, userID := sharedNote(t, h)
	listener := h.listen(userID)
	made := share(t, h, ana, "")
	if made["expiresIn"] != "never" || made["expiresAt"] != nil || made["expired"] != false {
		t.Fatalf("default: %v", made)
	}
	if !strings.HasSuffix(made["url"].(string), "/s/"+made["id"].(string)) {
		t.Fatalf("url %v", made["url"])
	}
	id := made["id"].(string)
	// sharing again gives the same link, without changing the deadline
	if again := share(t, h, ana, "1d"); again["id"] != id || again["expiresIn"] != "never" {
		t.Fatalf("again %v", again)
	}
	// "Mudar prazo": 1 day from now, same id and address
	res, changed := h.do(ana, call{method: http.MethodPatch, path: "/v1/shares/" + id, body: map[string]any{"expiresIn": "1d"}})
	if res.StatusCode != 200 || changed["id"] != id || changed["url"] != made["url"] || changed["expiresIn"] != "1d" {
		t.Fatalf("patch %d %v", res.StatusCode, changed)
	}
	at, _ := time.Parse(time.RFC3339, changed["expiresAt"].(string))
	if gap := at.Sub(h.now); gap < 23*time.Hour+59*time.Minute || gap > 24*time.Hour+time.Minute {
		t.Fatalf("1 day is %v", gap)
	}
	if res, body := h.do(ana, call{method: http.MethodPatch, path: "/v1/shares/" + id, body: map[string]any{"expiresIn": "2d"}}); res.StatusCode != 400 || body["error"] != "invalid_expires" {
		t.Fatalf("2 days: %d %v", res.StatusCode, body)
	}
	if !listener.sawShare(id) {
		t.Fatal("the other devices did not hear the change")
	}
	// the item's link, in any device, says the deadline
	if _, mine := h.do(ana, call{path: "/v1/shares?item=n1"}); mine["expiresIn"] != "1d" {
		t.Fatalf("item link %v", mine)
	}
}

func TestExpiredLinkShowsNothing(t *testing.T) {
	h := newHarness(t)
	ana, _ := sharedNote(t, h)
	made := share(t, h, ana, "1d")
	id := made["id"].(string)
	nobody := h.browser()
	if res, _ := h.do(nobody, call{path: "/v1/shared/" + id}); res.StatusCode != 200 {
		t.Fatalf("before: %d", res.StatusCode)
	}
	h.now = h.now.Add(24*time.Hour + time.Minute)
	for _, path := range []string{"/v1/shared/" + id, "/v1/shared/" + id + "/media/n1"} {
		res, body := h.do(nobody, call{path: path})
		if res.StatusCode != http.StatusGone || body["error"] != "link_expired" {
			t.Fatalf("%s: %d %v", path, res.StatusCode, body)
		}
	}
	// the person still sees it, as expired, and can give it a new deadline on the same address
	_, mine := h.do(ana, call{path: "/v1/shares?item=n1"})
	if mine["id"] != id || mine["expired"] != true {
		t.Fatalf("own view %v", mine)
	}
	if res, reopened := h.do(ana, call{method: http.MethodPatch, path: "/v1/shares/" + id, body: map[string]any{"expiresIn": "never"}}); res.StatusCode != 200 || reopened["expired"] != false {
		t.Fatalf("reopen %d %v", res.StatusCode, reopened)
	}
	if res, _ := h.do(nobody, call{path: "/v1/shared/" + id}); res.StatusCode != 200 {
		t.Fatalf("reopened: %d", res.StatusCode)
	}
	// a stopped link does not come back
	h.do(ana, call{method: http.MethodDelete, path: "/v1/shares/" + id})
	if res, body := h.do(ana, call{method: http.MethodPatch, path: "/v1/shares/" + id, body: map[string]any{"expiresIn": "7d"}}); res.StatusCode != http.StatusConflict || body["error"] != "stopped" {
		t.Fatalf("stopped: %d %v", res.StatusCode, body)
	}
}

func TestAllMyLinks(t *testing.T) {
	h := newHarness(t)
	ana, _ := sharedNote(t, h)
	putRow(t, h, ana, "n2", row("Outra", nil))
	first := share(t, h, ana, "1d")
	res, second := h.do(ana, call{method: http.MethodPost, path: "/v1/shares", body: map[string]any{"item": "n2", "kind": "file", "expiresIn": "7d"}})
	if res.StatusCode != 201 {
		t.Fatalf("second %d %v", res.StatusCode, second)
	}
	h.now = h.now.Add(25 * time.Hour)
	_, list := h.do(ana, call{path: "/v1/shares"})
	links, _ := list["links"].([]any)
	if len(links) != 2 {
		t.Fatalf("links %v", list)
	}
	// the expired ones last
	if links[0].(map[string]any)["id"] != second["id"] || links[1].(map[string]any)["id"] != first["id"] || links[1].(map[string]any)["expired"] != true {
		t.Fatalf("order %v", links)
	}
	other, _ := h.account("enabled", true, "outra@exemplo.com")
	if _, theirs := h.do(other, call{path: "/v1/shares"}); len(theirs["links"].([]any)) != 0 {
		t.Fatalf("another account sees %v", theirs)
	}
}

func (l *heard) sawShare(id string) bool {
	for _, message := range l.all() {
		if message["type"] == "share" && message["id"] == id {
			return true
		}
	}
	return false
}
