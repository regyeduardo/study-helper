package transcribe

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// The AI is asked as the app asks it (openAiChat): temperature 0.7, the JSON mode when the instruction asks for JSON, and a provider
// that refuses it (400) is asked again without the JSON mode, then without the limit of tokens.
func TestTheAIIsAskedAsTheAppAsksIt(t *testing.T) {
	bodies := []map[string]any{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		bodies = append(bodies, body)
		if len(bodies) < 3 {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":"campo desconhecido"}`))
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []map[string]any{{"message": map[string]any{"content": "ok"}}}})
	}))
	defer server.Close()
	cfg := Config{Keys: map[string]string{"openrouter": "or"}, Origins: map[string]string{"openrouter": server.URL}}
	answer, err := cfg.ChatLimit("openrouter", "texto", nil)(context.Background(), "nota", "Devolva SOMENTE um JSON", 0)
	if err != nil || answer != "ok" || len(bodies) != 3 {
		t.Fatalf("%q %v %d", answer, err, len(bodies))
	}
	first, second, third := bodies[0], bodies[1], bodies[2]
	if first["temperature"] != 0.7 || first["max_tokens"] != float64(16384) || first["response_format"] == nil {
		t.Fatalf("first %v", first)
	}
	if second["response_format"] != nil || second["max_tokens"] == nil || third["max_tokens"] != nil {
		t.Fatalf("second %v third %v", second, third)
	}
	// a field of the request taken away (nil) and one added
	bodies = bodies[:0]
	zero := 0.0
	_, _ = cfg.Asker("openrouter", "texto", nil)(context.Background(), "nota", "texto livre", AskOptions{Temperature: &zero, Extra: map[string]any{"plugins": []map[string]string{{"id": "web"}}, "temperature": nil}})
	if _, has := bodies[0]["temperature"]; has || bodies[0]["plugins"] == nil || bodies[0]["response_format"] != nil {
		t.Fatalf("%v", bodies[0])
	}
}
