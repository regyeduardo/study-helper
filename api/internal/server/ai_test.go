package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Spec 006: the app's AI for the people with the structure on. The browser calls /v1/ai/{provider}/{path...}; the server sends it on
// to the provider with the key of the env, and the key never reaches the browser.

type seen struct {
	method, path, query, auth, apiKey, googKey, cookie, version, body, contentType string
}

func fakeProvider(t *testing.T, reply func(w http.ResponseWriter)) (*httptest.Server, *[]seen) {
	t.Helper()
	calls := []seen{}
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		calls = append(calls, seen{r.Method, r.URL.Path, r.URL.RawQuery, r.Header.Get("Authorization"), r.Header.Get("X-Api-Key"), r.Header.Get("X-Goog-Api-Key"), r.Header.Get("Cookie"), r.Header.Get("Anthropic-Version"), string(body), r.Header.Get("Content-Type")})
		reply(w)
	}))
	t.Cleanup(provider.Close)
	return provider, &calls
}

func withAI(h *harness, keys map[string]string, origins map[string]string) {
	h.srv.cfg.AI = AIConfig{Keys: keys, Origins: origins}
}

func TestAIProxySendsWithTheEnvKey(t *testing.T) {
	h := newHarness(t)
	ana, _ := h.account("enabled", true, "ana@exemplo.com")
	provider, calls := fakeProvider(t, func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"Oi\"}}]}\n\ndata: [DONE]\n\n")
	})
	withAI(h, map[string]string{"deepinfra": "chave-secreta-da-deepinfra"}, map[string]string{"deepinfra": provider.URL})

	res, out := h.raw(ana, http.MethodPost, "/v1/ai/deepinfra/v1/openai/chat/completions?stream=1", []byte(`{"model":"m","stream":true}`), map[string]string{
		"Content-Type":  "application/json",
		"Authorization": "Bearer chave-do-navegador",
		"X-Api-Key":     "outra-do-navegador",
	})
	if res.StatusCode != 200 || !strings.Contains(string(out), "data: [DONE]") || res.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("stream: %d %q %v", res.StatusCode, out, res.Header)
	}
	got := (*calls)[0]
	if got.method != "POST" || got.path != "/v1/openai/chat/completions" || got.query != "stream=1" || got.body != `{"model":"m","stream":true}` {
		t.Fatalf("forwarded: %+v", got)
	}
	if got.auth != "Bearer chave-secreta-da-deepinfra" || got.apiKey != "" || got.cookie != "" {
		t.Fatalf("the env key goes, the browser's never: %+v", got)
	}
	if strings.Contains(string(out), "chave-secreta") {
		t.Fatalf("the key reached the browser: %q", out)
	}
}

func TestAIProxyAnthropicAndGeminiHeaders(t *testing.T) {
	h := newHarness(t)
	ana, _ := h.account("enabled", true, "ana@exemplo.com")
	provider, calls := fakeProvider(t, func(w http.ResponseWriter) { _, _ = io.WriteString(w, `{}`) })
	withAI(h, map[string]string{"anthropic": "k-anthropic", "gemini": "k-gemini"}, map[string]string{"anthropic": provider.URL, "gemini": provider.URL})

	h.raw(ana, http.MethodPost, "/v1/ai/anthropic/v1/messages", []byte(`{}`), map[string]string{"Content-Type": "application/json"})
	if got := (*calls)[0]; got.apiKey != "k-anthropic" || got.version == "" || got.auth != "" {
		t.Fatalf("anthropic: %+v", got)
	}
	h.raw(ana, http.MethodPost, "/v1/ai/gemini/v1beta/openai/chat/completions", []byte(`{}`), map[string]string{"Content-Type": "application/json"})
	if got := (*calls)[1]; got.auth != "Bearer k-gemini" || got.googKey != "k-gemini" {
		t.Fatalf("gemini: %+v", got)
	}
}

func TestAIProxyPassesTheAudioOfATranscription(t *testing.T) {
	h := newHarness(t)
	ana, _ := h.account("enabled", true, "ana@exemplo.com")
	provider, calls := fakeProvider(t, func(w http.ResponseWriter) { _, _ = io.WriteString(w, `{"text":"olá"}`) })
	withAI(h, map[string]string{"groq": "k-groq"}, map[string]string{"groq": provider.URL})
	form := "--b\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.webm\"\r\nContent-Type: audio/webm\r\n\r\nSOM\r\n--b--\r\n"
	res, out := h.raw(ana, http.MethodPost, "/v1/ai/groq/openai/v1/audio/transcriptions", []byte(form), map[string]string{"Content-Type": "multipart/form-data; boundary=b"})
	if res.StatusCode != 200 || string(out) != `{"text":"olá"}` {
		t.Fatalf("transcription: %d %q", res.StatusCode, out)
	}
	if got := (*calls)[0]; got.body != form || got.contentType != "multipart/form-data; boundary=b" {
		t.Fatalf("the audio goes whole: %+v", got)
	}
}

func TestAIProxyRefusals(t *testing.T) {
	h := newHarness(t)
	provider, _ := fakeProvider(t, func(w http.ResponseWriter) { _, _ = io.WriteString(w, `{}`) })
	withAI(h, map[string]string{"deepinfra": "k"}, map[string]string{"deepinfra": provider.URL, "openai": provider.URL})
	off, _ := h.account("enabled", false, "bia@exemplo.com")
	on, _ := h.account("enabled", true, "ana@exemplo.com")
	cases := map[string]struct {
		client *http.Client
		path   string
		status int
		code   string
	}{
		"no session":        {h.browser(), "/v1/ai/deepinfra/v1/openai/chat/completions", 401, ""},
		"structure off":     {off, "/v1/ai/deepinfra/v1/openai/chat/completions", 403, "app_disabled"},
		"unknown provider":  {on, "/v1/ai/custom/chat/completions", 404, "unknown_provider"},
		"no key in the env": {on, "/v1/ai/openai/v1/chat/completions", 503, "ai_not_configured"},
	}
	for name, c := range cases {
		res, out := h.raw(c.client, http.MethodPost, c.path, []byte(`{}`), map[string]string{"Content-Type": "application/json"})
		if res.StatusCode != c.status || (c.code != "" && !strings.Contains(string(out), c.code)) {
			t.Fatalf("%s: %d %s", name, res.StatusCode, out)
		}
	}
}

func TestAIConfigAndAdmin(t *testing.T) {
	h := newHarness(t)
	withAI(h, map[string]string{"deepinfra": "k-deep", "anthropic": "k-anth"}, nil)
	ana, _ := h.account("enabled", true, "ana@exemplo.com")
	owner, ownerID := h.account("enabled", true, "dono@exemplo.com")
	if _, err := h.db.Exec(`UPDATE user SET email_verified = 1 WHERE id = ?`, ownerID); err != nil {
		t.Fatal(err)
	}

	uses := `{"uses":{"transcricao":{"provider":"deepinfra","model":"openai/whisper-large-v3-turbo"},"aula":{"provider":"anthropic","model":"claude"}}}`
	if res, out := h.raw(ana, http.MethodPut, "/v1/admin/ai", []byte(uses), map[string]string{"Content-Type": "application/json"}); res.StatusCode != 404 {
		t.Fatalf("only the administration account sets the app's AI (others see nothing there): %d %s", res.StatusCode, out)
	}
	if res, out := h.raw(owner, http.MethodPut, "/v1/admin/ai", []byte(uses), map[string]string{"Content-Type": "application/json"}); res.StatusCode != 200 {
		t.Fatalf("admin put: %d %s", res.StatusCode, out)
	}
	res, out := h.raw(owner, http.MethodGet, "/v1/admin/ai", nil, nil)
	if res.StatusCode != 200 || !strings.Contains(string(out), `"deepinfra"`) || !strings.Contains(string(out), "whisper-large-v3-turbo") {
		t.Fatalf("admin get: %d %s", res.StatusCode, out)
	}
	res, out = h.raw(ana, http.MethodGet, "/v1/ai/config", nil, nil)
	if res.StatusCode != 200 || !strings.Contains(string(out), `"anthropic"`) || !strings.Contains(string(out), `"transcricao"`) {
		t.Fatalf("config: %d %s", res.StatusCode, out)
	}
	for _, body := range [][]byte{out} {
		if strings.Contains(string(body), "k-deep") || strings.Contains(string(body), "k-anth") {
			t.Fatalf("a key reached the browser: %s", body)
		}
	}
	off, _ := h.account("enabled", false, "bia@exemplo.com")
	if res, _ := h.raw(off, http.MethodGet, "/v1/ai/config", nil, nil); res.StatusCode != 403 {
		t.Fatalf("config without the structure: %d", res.StatusCode)
	}
}
