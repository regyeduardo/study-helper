package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"strings"
	"time"
)

// The server's AI client (spec 004, T009): text, voice and transcription with the keys of the server's env only. A key never goes
// in an error or a log; a provider that fails answers ErrProviderDown, and the caller tries the next model of the use.

var (
	// ErrProviderDown is any refusal or failure of the provider (the API answers 502 provider_down).
	ErrProviderDown = errors.New("provider_down")
	// ErrNoKey: the server has no key for that provider.
	ErrNoKey = errors.New("ai_not_configured")
)

// defaultBases are the OpenAI-like addresses of the providers the languages mode uses.
var defaultBases = map[string]string{
	"deepinfra":  "https://api.deepinfra.com/v1/openai",
	"openrouter": "https://openrouter.ai/api/v1",
}

// Client calls the providers. Keys come from the env (DEEPINFRA_API_KEY, OPENROUTER_API_KEY); Bases replace the addresses in tests.
type Client struct {
	Keys  map[string]string
	Bases map[string]string
	HTTP  *http.Client
	// MaxTokens bounds the answer of Chat (the provider's default when zero; some cut long answers short)
	MaxTokens int
}

// paths are what goes after a provider's origin to reach its OpenAI-like API.
var paths = map[string]string{"deepinfra": "/v1/openai", "openrouter": "/api/v1"}

// BasesFrom are the addresses of the providers for other origins (the tests' fake providers).
func BasesFrom(origins map[string]string) map[string]string {
	out := map[string]string{}
	for provider, origin := range origins {
		if path, ok := paths[provider]; ok {
			out[provider] = strings.TrimRight(origin, "/") + path
		}
	}
	return out
}

func (c *Client) base(provider string) string {
	if base, ok := c.Bases[provider]; ok {
		return base
	}
	return defaultBases[provider]
}

func (c *Client) do(ctx context.Context, model Model, path, contentType string, body []byte) ([]byte, error) {
	key := c.Keys[model.Provider]
	if key == "" {
		return nil, ErrNoKey
	}
	base := c.base(model.Provider)
	if base == "" {
		return nil, ErrProviderDown
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, base+path, bytes.NewReader(body))
	if err != nil {
		return nil, ErrProviderDown
	}
	request.Header.Set("Authorization", "Bearer "+key)
	request.Header.Set("Content-Type", contentType)
	client := c.HTTP
	if client == nil {
		client = &http.Client{Timeout: 2 * time.Minute}
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, ErrProviderDown
	}
	defer response.Body.Close()
	out, err := io.ReadAll(io.LimitReader(response.Body, 64<<20))
	if err != nil || response.StatusCode >= 300 {
		return nil, ErrProviderDown
	}
	return out, nil
}

// Chat sends one user message and gives back the text of the answer; `asJSON` asks for a JSON object.
func (c *Client) Chat(ctx context.Context, model Model, prompt string, asJSON bool) (string, error) {
	request := map[string]any{"model": model.ID, "messages": []map[string]string{{"role": "user", "content": prompt}}}
	if asJSON {
		request["response_format"] = map[string]string{"type": "json_object"}
	}
	if c.MaxTokens > 0 {
		request["max_tokens"] = c.MaxTokens
	}
	body, _ := json.Marshal(request)
	out, err := c.do(ctx, model, "/chat/completions", "application/json", body)
	if err != nil {
		return "", err
	}
	var answer struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if json.Unmarshal(out, &answer) != nil || len(answer.Choices) == 0 {
		return "", ErrProviderDown
	}
	return answer.Choices[0].Message.Content, nil
}

// Speech is the model voice saying `text`, in mp3; `lang` goes to the voices that speak many languages (not to English).
func (c *Client) Speech(ctx context.Context, model Model, text, voice, lang string) ([]byte, error) {
	request := map[string]string{"model": model.ID, "input": text, "voice": voice, "response_format": "mp3"}
	if lang != "" && lang != "en" {
		request["language"] = lang
	}
	body, _ := json.Marshal(request)
	out, err := c.do(ctx, model, "/audio/speech", "application/json", body)
	if err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return nil, ErrProviderDown
	}
	return out, nil
}

// Transcribe is what a speech model heard in a recording (a WAV), without knowing the expected sentence.
func (c *Client) Transcribe(ctx context.Context, model Model, audio []byte, lang string) (string, error) {
	var form bytes.Buffer
	writer := multipart.NewWriter(&form)
	_ = writer.WriteField("model", model.ID)
	if lang != "" {
		_ = writer.WriteField("language", lang)
	}
	part, _ := writer.CreateFormFile("file", "fala.wav")
	_, _ = part.Write(audio)
	_ = writer.Close()
	out, err := c.do(ctx, model, "/audio/transcriptions", writer.FormDataContentType(), form.Bytes())
	if err != nil {
		return "", err
	}
	var answer struct {
		Text string `json:"text"`
	}
	if json.Unmarshal(out, &answer) != nil {
		return "", ErrProviderDown
	}
	return answer.Text, nil
}
