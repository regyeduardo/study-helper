package server

import (
	"context"
	"testing"
)

// The space used (spec 007, história 5, FR-050 to FR-055; contracts/api-space.md): notes, media and the Lixeira apart, what is left of
// the 10 GB, the biggest first, the same number for the owner, and the daily check against what the storage really keeps.

func TestSpaceBreakdown(t *testing.T) {
	h := newHarness(t)
	ana, anaID := h.account("enabled", true, "ana@exemplo.com")
	storedMedia(t, h, ana) // n1 with 10 bytes of media
	putPart(t, h, ana, "n1", "text", "12345")
	putRow(t, h, ana, "n2", row("Na Lixeira", map[string]any{"trashedAt": "2026-11-24T10:00:00Z", "trashedWith": "n2"}))
	putPart(t, h, ana, "n2", "text", "1234567")
	res, space := h.do(ana, call{path: "/v1/space"})
	if res.StatusCode != 200 {
		t.Fatalf("space %d %v", res.StatusCode, space)
	}
	if num(space["notes"]) != 5 || num(space["media"]) != 10 || num(space["trash"]) != 7 || num(space["limit"]) != 10737418240 || num(space["warnAt"]) != 9663676416 {
		t.Fatalf("breakdown %v", space)
	}
	if num(space["used"]) != num(space["notes"])+num(space["media"])+num(space["trash"])+num(space["reserved"]) || num(space["free"]) != 10737418240-num(space["used"]) {
		t.Fatalf("totals %v", space)
	}
	// the biggest first, only the account's
	_, largest := h.do(ana, call{path: "/v1/space/largest"})
	items := largest["items"].([]any)
	if len(items) != 2 || items[0].(map[string]any)["id"] != "n1" || items[1].(map[string]any)["trashed"] != true {
		t.Fatalf("largest %v", largest)
	}
	other, _ := h.account("enabled", true, "outra@exemplo.com")
	if _, theirs := h.do(other, call{path: "/v1/space/largest"}); len(theirs["items"].([]any)) != 0 {
		t.Fatalf("another account sees %v", theirs)
	}
	// the owner sees the same number for the account (FR-055)
	owner, _ := h.admin()
	_, accounts := h.do(owner, call{path: "/v1/admin/accounts"})
	for _, item := range accounts["accounts"].([]any) {
		account := item.(map[string]any)
		if account["id"] == anaID {
			got := account["space"].(map[string]any)
			if num(got["used"]) != num(space["used"]) || num(got["trash"]) != 7 {
				t.Fatalf("admin %v vs %v", got, space)
			}
		}
	}
}

func TestSpaceCheckCountsTheStorage(t *testing.T) {
	h := newHarness(t)
	ana, anaID := h.account("enabled", true, "ana@exemplo.com")
	storedMedia(t, h, ana)
	putPart(t, h, ana, "n1", "text", "12345")
	// something kept that the map does not know (an object left behind), and an orphan waiting for its cleaning (it does not count)
	_ = h.blobs.Put(context.Background(), "u/"+anaID+"/i/n1/media/perdida.webm", []byte("1234567890"), "video/webm", nil)
	_ = h.blobs.Put(context.Background(), "u/"+anaID+"/i/n1/text/velho.md", []byte("123"), "text/markdown", nil)
	_, _ = h.db.Exec(`INSERT INTO orphans (object_key, user_id, reason, since) VALUES (?, ?, 'replaced', ?)`, "u/"+anaID+"/i/n1/text/velho.md", anaID, stamp(h.now))
	if err := h.srv.CheckUsage(context.Background()); err != nil {
		t.Fatal(err)
	}
	_, space := h.do(ana, call{path: "/v1/space"})
	if num(space["media"]) != 20 || num(space["notes"]) != 5 {
		t.Fatalf("after the check %v", space)
	}
	var diff int64
	_ = h.db.QueryRow(`SELECT usage_diff FROM user WHERE id = ?`, anaID).Scan(&diff)
	if diff != -10 {
		t.Fatalf("diff %d", diff)
	}
}

func TestSpaceEventHasTheTrash(t *testing.T) {
	h := newHarness(t)
	ana, anaID := h.account("enabled", true, "ana@exemplo.com")
	listener := h.listen(anaID)
	putRow(t, h, ana, "n2", row("Na Lixeira", map[string]any{"trashedAt": "2026-11-24T10:00:00Z", "trashedWith": "n2"}))
	putPart(t, h, ana, "n2", "text", "1234567")
	h.srv.notifySpace(anaID)
	for _, message := range listener.all() {
		if message["type"] == "space" {
			if _, ok := message["trash"]; ok {
				return
			}
		}
	}
	t.Fatalf("no trash in the space event: %v", listener.all())
}
