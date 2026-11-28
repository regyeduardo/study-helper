package transcribe

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// T205: the vision model is asked as the browser asks it (visionController): the photos as image_url, then the prompt, with a limit of
// tokens; what it cost is counted.
func TestTheVisionModelGetsThePhotosAndThePrompt(t *testing.T) {
	var asked map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer or" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewDecoder(r.Body).Decode(&asked)
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []map[string]any{{"message": map[string]any{"content": `{"texto": "VGV"}`}}}, "usage": map[string]any{"cost": 0.0003}})
	}))
	defer server.Close()
	spent := 0.0
	cfg := Config{Keys: map[string]string{"openrouter": "or"}, Origins: map[string]string{"openrouter": server.URL}}
	see, err := cfg.SeeWith("openrouter", "visao", 1024, time.Minute, func(usd float64) { spent += usd })
	if err != nil {
		t.Fatal(err)
	}
	answer, err := see(context.Background(), []string{"data:image/jpeg;base64,AAA"}, "Leia a tela")
	if err != nil || answer != `{"texto": "VGV"}` || spent != 0.0003 {
		t.Fatalf("%q %v %v", answer, err, spent)
	}
	raw, _ := json.Marshal(asked)
	if !strings.Contains(string(raw), `"image_url":{"url":"data:image/jpeg;base64,AAA"}`) || !strings.Contains(string(raw), `"text":"Leia a tela"`) || asked["max_tokens"] != float64(1024) || asked["model"] != "visao" {
		t.Fatalf("%s", raw)
	}
}

func TestAVisionModelTheServerCannotAskSaysWhy(t *testing.T) {
	cfg := Config{Keys: map[string]string{"openrouter": "or"}}
	if _, err := cfg.SeeWith("deepseek", "visao", 16, time.Minute, nil); err == nil || !strings.Contains(err.Error(), "falta a chave") {
		t.Fatalf("%v", err)
	}
	if _, err := cfg.SeeWith("custom", "visao", 16, time.Minute, nil); err == nil || !strings.Contains(err.Error(), "não roda no servidor") {
		t.Fatalf("%v", err)
	}
}
