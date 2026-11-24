package ai

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// T008 (spec 004): the server's AI client, with fake DeepInfra and OpenRouter: text in JSON, voice in mp3, transcription;
// a provider error becomes ErrProviderDown; the key goes only in the header, never in an error.
func fakeProviders(t *testing.T) (*Client, *[]*http.Request) {
	t.Helper()
	seen := []*http.Request{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		r.Body = io.NopCloser(strings.NewReader(string(body)))
		seen = append(seen, r)
		switch {
		case strings.HasSuffix(r.URL.Path, "/chat/completions"):
			if strings.Contains(string(body), "quebra") {
				http.Error(w, `{"error":{"message":"overloaded"}}`, 503)
				return
			}
			_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"{\"ok\":true}"}}]}`)
		case strings.HasSuffix(r.URL.Path, "/audio/speech"):
			w.Header().Set("Content-Type", "audio/mpeg")
			_, _ = w.Write([]byte("ID3mp3"))
		case strings.HasSuffix(r.URL.Path, "/audio/transcriptions"):
			_, _ = io.WriteString(w, `{"text":"the long road"}`)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	client := &Client{Keys: map[string]string{"deepinfra": "k-deep", "openrouter": "k-or"}, Bases: map[string]string{"deepinfra": server.URL + "/v1/openai", "openrouter": server.URL + "/api/v1"}}
	return client, &seen
}

func TestClientTextVoiceAndTranscription(t *testing.T) {
	client, seen := fakeProviders(t)
	ctx := context.Background()
	text, err := client.Chat(ctx, Model{"openrouter", "google/gemini-3-flash-preview"}, "Gere os cards", true)
	if err != nil || text != `{"ok":true}` {
		t.Fatalf("chat: %q %v", text, err)
	}
	var sent struct {
		Model          string         `json:"model"`
		ResponseFormat map[string]any `json:"response_format"`
	}
	request := (*seen)[0]
	body, _ := io.ReadAll(request.Body)
	_ = json.Unmarshal(body, &sent)
	if request.Header.Get("Authorization") != "Bearer k-or" || sent.Model != "google/gemini-3-flash-preview" || sent.ResponseFormat["type"] != "json_object" {
		t.Fatalf("chat request: %s %s", request.Header.Get("Authorization"), body)
	}
	audio, err := client.Speech(ctx, Model{"deepinfra", "hexgrad/Kokoro-82M"}, "The long road", "af_heart", "en")
	if err != nil || string(audio) != "ID3mp3" || (*seen)[1].Header.Get("Authorization") != "Bearer k-deep" {
		t.Fatalf("speech: %q %v", audio, err)
	}
	heard, err := client.Transcribe(ctx, Model{"deepinfra", "openai/whisper-large-v3"}, []byte("RIFFwav"), "en")
	if err != nil || heard != "the long road" {
		t.Fatalf("transcribe: %q %v", heard, err)
	}
}

func TestClientProviderDownAndNoKey(t *testing.T) {
	client, _ := fakeProviders(t)
	_, err := client.Chat(context.Background(), Model{"deepinfra", "m"}, "quebra", false)
	if err != ErrProviderDown || strings.Contains(err.Error(), "k-deep") {
		t.Fatalf("provider down: %v", err)
	}
	client.Keys = map[string]string{}
	if _, err := client.Chat(context.Background(), Model{"deepinfra", "m"}, "x", false); err != ErrNoKey {
		t.Fatalf("no key: %v", err)
	}
}
