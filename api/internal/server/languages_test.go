package server

import (
	"context"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/regyeduardo/study-helper/api/internal/ai"
)

// T014 and T022 (routes): the languages mode over HTTP, only with the structure on. The AI is a fake that answers the test text.

type cardWriter struct {
	mu    sync.Mutex
	calls int
	fail  bool
}

func (c *cardWriter) Chat(context.Context, ai.Model, string, bool) (string, error) {
	c.mu.Lock()
	c.calls++
	fail := c.fail
	c.mu.Unlock()
	if fail {
		return "", ai.ErrProviderDown
	}
	raw, err := os.ReadFile("../langs/testdata/ok.json")
	return string(raw), err
}

type modelVoice struct{ calls int }

func (v *modelVoice) Speech(_ context.Context, _ ai.Model, text, _, _ string) ([]byte, error) {
	v.calls++
	if text == "down" {
		return nil, ai.ErrProviderDown
	}
	return []byte("ID3" + text), nil
}

func languagesHarness(t *testing.T) (*harness, *cardWriter, *modelVoice) {
	h := newHarness(t)
	writer, voice := &cardWriter{}, &modelVoice{}
	h.srv.cfg.LanguagesAI, h.srv.cfg.Voice = writer, voice
	h.srv.cfg.LeadIn = func(b []byte) []byte { return b }
	h.srv.startLanguages()
	return h, writer, voice
}

func TestLanguagesNeedTheStructure(t *testing.T) {
	h, _, _ := languagesHarness(t)
	off, _ := h.account("enabled", false, "sem@exemplo.com")
	for _, c := range []call{{path: "/v1/languages"}, {method: "POST", path: "/v1/languages", body: map[string]any{"code": "en"}}, {method: "POST", path: "/v1/speech/tts", body: map[string]any{"text": "hi"}}} {
		if res, body := h.do(off, c); res.StatusCode != 403 || body["error"] != "app_disabled" {
			t.Fatalf("%s %s: %d %v", c.method, c.path, res.StatusCode, body)
		}
	}
	nobody := h.browser()
	if res, _ := h.do(nobody, call{path: "/v1/languages"}); res.StatusCode != 401 {
		t.Fatalf("no session: %d", res.StatusCode)
	}
}

func TestLanguagesRoutes(t *testing.T) {
	h, writer, _ := languagesHarness(t)
	ana, _ := h.account("enabled", true, "ana@exemplo.com")
	if res, body := h.do(ana, call{method: "POST", path: "/v1/languages", body: map[string]any{"code": "en"}}); res.StatusCode != 201 || body["name"] != "Inglês" || body["locale"] != "en-US" {
		t.Fatalf("create: %d %v", res.StatusCode, body)
	}
	if res, body := h.do(ana, call{method: "POST", path: "/v1/languages", body: map[string]any{"code": "en"}}); res.StatusCode != 409 || body["error"] != "language_exists" {
		t.Fatalf("twice: %d %v", res.StatusCode, body)
	}
	if res, body := h.do(ana, call{method: "POST", path: "/v1/languages", body: map[string]any{"code": "não é código"}}); res.StatusCode != 422 || body["error"] != "invalid_language" {
		t.Fatalf("invalid: %d %v", res.StatusCode, body)
	}
	if res, body := h.do(ana, call{method: "POST", path: "/v1/languages", body: map[string]any{"code": "es"}}); res.StatusCode != 201 {
		t.Fatalf("Spanish: %d %v", res.StatusCode, body)
	}
	res, body := h.do(ana, call{path: "/v1/languages"})
	list, _ := body["languages"].([]any)
	if res.StatusCode != 200 || len(list) != 2 || res.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("list: %d %v", res.StatusCode, body)
	}

	// a text: 202 generating, then ready
	res, body = h.do(ana, call{method: "POST", path: "/v1/languages/en/texts", body: map[string]any{"title": "Chuva", "text": "I used to walk to school every day\nBut now I won't walk in the rain"}})
	if res.StatusCode != 202 || body["status"] != "generating" {
		t.Fatalf("text: %d %v", res.StatusCode, body)
	}
	id, _ := body["id"].(string)
	h.srv.WaitLanguages()
	res, body = h.do(ana, call{path: "/v1/languages/en/texts/" + id})
	items, _ := body["items"].(map[string]any)
	lines, _ := body["lines"].([]any)
	if res.StatusCode != 200 || len(items) != 4 || len(lines) != 2 || body["locale"] != "en-US" || writer.calls != 1 {
		t.Fatalf("ready: %d %v", res.StatusCode, body)
	}
	res, body = h.do(ana, call{path: "/v1/languages/en"})
	texts, _ := body["texts"].([]any)
	if res.StatusCode != 200 || body["items"] != float64(4) || len(texts) != 1 || texts[0].(map[string]any)["progress"] != "start" {
		t.Fatalf("detail: %d %v", res.StatusCode, body)
	}
	if res, body := h.do(ana, call{path: "/v1/languages/fr"}); res.StatusCode != 404 || body["error"] != "not_found" {
		t.Fatalf("no French: %d %v", res.StatusCode, body)
	}

	// errors of a text
	big := strings.Repeat("a", 100_001)
	if res, body := h.do(ana, call{method: "POST", path: "/v1/languages/en/texts", body: map[string]any{"title": "Grande", "text": big}}); res.StatusCode != 413 || body["error"] != "text_too_large" {
		t.Fatalf("too large: %d %v", res.StatusCode, body)
	}
	if res, body := h.do(ana, call{method: "POST", path: "/v1/languages/en/texts", body: map[string]any{"title": "Vazio", "text": " "}}); res.StatusCode != 422 || body["error"] != "text_required" {
		t.Fatalf("empty: %d %v", res.StatusCode, body)
	}
	if res, body := h.do(ana, call{method: "POST", path: "/v1/languages/en/texts", body: map[string]any{"title": "Link", "url": "https://exemplo.com/letra"}}); res.StatusCode != 422 || body["error"] != "link_unreadable" {
		t.Fatalf("link: %d %v", res.StatusCode, body)
	}

	// an answer, the knowledge, the progress
	if res, body := h.do(ana, call{method: "POST", path: "/v1/languages/en/answers", body: map[string]any{"textId": id, "cardId": id + ".p_mp", "stage": "practice", "promptLang": "native", "answer": "walk", "ok": true, "schedule": map[string]any{"state": "review", "scheduledDays": 2, "dueAt": "2026-11-26T10:00:00.000Z", "reps": 2}}}); res.StatusCode != 204 {
		t.Fatalf("answer: %d %v", res.StatusCode, body)
	}
	if res, body := h.do(ana, call{method: "POST", path: "/v1/languages/en/answers", body: map[string]any{"textId": id, "cardId": id + ".p_mp", "stage": "?", "promptLang": "native"}}); res.StatusCode != 422 || body["error"] != "invalid_answer" {
		t.Fatalf("bad answer: %d %v", res.StatusCode, body)
	}
	res, body = h.do(ana, call{path: "/v1/languages/en/knowledge"})
	if walk, _ := body["walk"].(map[string]any); res.StatusCode != 200 || walk["listen"] != "learning" {
		t.Fatalf("knowledge: %d %v", res.StatusCode, body)
	}
	if res, _ := h.do(ana, call{path: "/v1/languages/en/texts/" + id + "/progress"}); res.StatusCode != 404 {
		t.Fatalf("no progress yet: %d", res.StatusCode)
	}
	if res, body := h.do(ana, call{method: "PUT", path: "/v1/languages/en/texts/" + id + "/progress", body: map[string]any{"state": map[string]any{"at": 2}}}); res.StatusCode != 204 {
		t.Fatalf("save progress: %d %v", res.StatusCode, body)
	}
	if res, body := h.do(ana, call{path: "/v1/languages/en/texts/" + id + "/progress"}); res.StatusCode != 200 || body["state"].(map[string]any)["at"] != float64(2) {
		t.Fatalf("progress: %d %v", res.StatusCode, body)
	}

	// another account never sees hers
	bia, _ := h.account("enabled", true, "bia@exemplo.com")
	if res, _ := h.do(bia, call{path: "/v1/languages/en/texts/" + id}); res.StatusCode != 404 {
		t.Fatalf("not hers: %d", res.StatusCode)
	}

	// delete keeps the base
	if res, _ := h.do(ana, call{method: "DELETE", path: "/v1/languages/en/texts/" + id}); res.StatusCode != 204 {
		t.Fatalf("delete: %d", res.StatusCode)
	}
	if _, body := h.do(ana, call{path: "/v1/languages/en"}); body["items"] != float64(4) || len(body["texts"].([]any)) != 0 {
		t.Fatalf("after delete: %v", body)
	}
}

func TestTextFailsAndRetries(t *testing.T) {
	h, writer, _ := languagesHarness(t)
	ana, _ := h.account("enabled", true, "ana@exemplo.com")
	h.do(ana, call{method: "POST", path: "/v1/languages", body: map[string]any{"code": "en"}})
	writer.fail = true
	_, body := h.do(ana, call{method: "POST", path: "/v1/languages/en/texts", body: map[string]any{"title": "Queda", "text": "I walk"}})
	id, _ := body["id"].(string)
	h.srv.WaitLanguages()
	if res, body := h.do(ana, call{path: "/v1/languages/en/texts/" + id}); res.StatusCode != 409 || body["error"] != "not_ready" || body["status"] != "failed" || body["reason"] != "provider_down" {
		t.Fatalf("failed: %d %v", res.StatusCode, body)
	}
	writer.fail = false
	if res, body := h.do(ana, call{method: "POST", path: "/v1/languages/en/texts/" + id + "/retry"}); res.StatusCode != 202 || body["status"] != "generating" {
		t.Fatalf("retry: %d %v", res.StatusCode, body)
	}
	h.srv.WaitLanguages()
	if res, _ := h.do(ana, call{path: "/v1/languages/en/texts/" + id}); res.StatusCode != 200 {
		t.Fatalf("ready after retry: %d", res.StatusCode)
	}
	if res, body := h.do(ana, call{method: "POST", path: "/v1/languages/en/texts/" + id + "/retry"}); res.StatusCode != 409 || body["error"] != "not_failed" {
		t.Fatalf("retry a ready one: %d %v", res.StatusCode, body)
	}
}

func TestTextsLeftGeneratingResume(t *testing.T) {
	h, writer, _ := languagesHarness(t)
	ana, _ := h.account("enabled", true, "ana@exemplo.com")
	h.do(ana, call{method: "POST", path: "/v1/languages", body: map[string]any{"code": "en"}})
	var user string
	_ = h.db.QueryRow(`SELECT id FROM user WHERE email = 'ana@exemplo.com'`).Scan(&user)
	if _, err := h.db.Exec(`INSERT INTO lang_texts (user_id, id, language, title, body, status, created_at) VALUES (?, 'parado', 'en', 'Parado', 'I walk', 'generating', '2026-11-23T00:00:00.000Z')`, user); err != nil {
		t.Fatal(err)
	}
	h.srv.ResumeLanguages()
	h.srv.WaitLanguages()
	if res, _ := h.do(ana, call{path: "/v1/languages/en/texts/parado"}); res.StatusCode != 200 || writer.calls != 1 {
		t.Fatalf("resumed: %d %d", res.StatusCode, writer.calls)
	}
}

func TestReportRoute(t *testing.T) {
	h, writer, _ := languagesHarness(t)
	ana, _ := h.account("enabled", true, "ana@exemplo.com")
	h.do(ana, call{method: "POST", path: "/v1/languages", body: map[string]any{"code": "en"}})
	_, body := h.do(ana, call{method: "POST", path: "/v1/languages/en/texts", body: map[string]any{"title": "Chuva", "text": "I walk"}})
	id, _ := body["id"].(string)
	h.srv.WaitLanguages()
	if res, body := h.do(ana, call{method: "POST", path: "/v1/languages/en/texts/" + id + "/cards/walk__1/report", body: map[string]any{"reason": "nope"}}); res.StatusCode != 422 || body["error"] != "invalid_reason" {
		t.Fatalf("bad reason: %d %v", res.StatusCode, body)
	}
	if res, _ := h.do(ana, call{method: "POST", path: "/v1/languages/en/texts/" + id + "/cards/ghost/report", body: map[string]any{"reason": "other"}}); res.StatusCode != 404 {
		t.Fatalf("unknown card: %d", res.StatusCode)
	}
	before := writer.calls
	if res, body := h.do(ana, call{method: "POST", path: "/v1/languages/en/texts/" + id + "/cards/walk__1/report", body: map[string]any{"reason": "two_right", "note": "andar e caminhar"}}); res.StatusCode != 202 || body["status"] != "remaking" {
		t.Fatalf("report: %d %v", res.StatusCode, body)
	}
	h.srv.WaitLanguages()
	if writer.calls == before {
		t.Fatal("the card was made again by the AI")
	}
	// the word is in the R2 cache, for everyone
	if _, _, err := h.blobs.Get(context.Background(), "lang/items/en/walk.json", nil); err != nil {
		t.Fatalf("kept in R2: %v", err)
	}
}

func TestModelVoiceRoute(t *testing.T) {
	h, _, voice := languagesHarness(t)
	ana, _ := h.account("enabled", true, "ana@exemplo.com")
	res, out := h.raw(ana, http.MethodPost, "/v1/speech/tts", []byte(`{"text":"The long road","locale":"en-US"}`), map[string]string{"Content-Type": "application/json"})
	if res.StatusCode != 200 || res.Header.Get("Content-Type") != "audio/mpeg" || string(out) != "ID3The long road" {
		t.Fatalf("voice: %d %q %v", res.StatusCode, out, res.Header)
	}
	h.raw(ana, http.MethodPost, "/v1/speech/tts", []byte(`{"text":"The long road","locale":"en-US"}`), map[string]string{"Content-Type": "application/json"})
	if voice.calls != 1 {
		t.Fatalf("cached in the storage: %d calls", voice.calls)
	}
	if res, _ := h.raw(ana, http.MethodPost, "/v1/speech/tts", []byte(`{"text":"down"}`), map[string]string{"Content-Type": "application/json"}); res.StatusCode != 502 {
		t.Fatalf("provider down: %d", res.StatusCode)
	}
	if res, _ := h.raw(ana, http.MethodPost, "/v1/speech/tts", []byte(`{"text":""}`), map[string]string{"Content-Type": "application/json"}); res.StatusCode != 422 {
		t.Fatalf("empty: %d", res.StatusCode)
	}
}
