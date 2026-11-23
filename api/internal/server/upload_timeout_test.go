package server

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/regyeduardo/study-helper/api/internal/blobs"
)

// stuckStorage never answers a part until the request gives up (23/11: an upload of 538 MB looked stuck with no news).
type stuckStorage struct{ *blobs.Memory }

func (stuckStorage) UploadPart(ctx context.Context, _, _ string, _ int, _ []byte) (string, error) {
	<-ctx.Done()
	return "", ctx.Err()
}

func TestAPartNeverWaitsForeverOnTheStorage(t *testing.T) {
	h := newHarness(t)
	ana, _ := h.account("enabled", true, "ana@exemplo.com")
	h.do(ana, call{method: http.MethodPut, path: "/v1/library/items/n1", body: map[string]any{"baseRev": 0, "row": row("Reunião", nil)}})
	_, body := h.do(ana, call{method: http.MethodPost, path: "/v1/uploads", body: map[string]any{"item": "n1", "media": "m1", "name": "reuniao.webm", "mime": "video/webm", "bytes": 10}})
	upload, _ := body["upload"].(string)
	h.srv.cfg.Blobs = stuckStorage{h.blobs}
	h.srv.cfg.PartTimeout = 50 * time.Millisecond
	started := time.Now()
	res, out := h.raw(ana, http.MethodPut, "/v1/uploads/"+upload+"/parts/1", []byte("abcd"), nil)
	if res.StatusCode != http.StatusBadGateway || time.Since(started) > 5*time.Second {
		t.Fatalf("a stuck part fails in time, so the app sends it again: %d %s after %s", res.StatusCode, out, time.Since(started))
	}
}
