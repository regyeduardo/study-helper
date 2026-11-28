package transcribe

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"
)

// chatPaths: where each provider of OpenAI format answers chat, after its origin (src/lib/ai/providers.ts, baseUrl + /chat/completions).
var chatPaths = map[string]string{
	"deepinfra": "/v1/openai/chat/completions", "openrouter": "/api/v1/chat/completions", "vercel": "/v1/chat/completions",
	"deepseek": "/chat/completions", "xai": "/v1/chat/completions", "mistral": "/v1/chat/completions", "openai": "/v1/chat/completions",
	"gemini": "/v1beta/openai/chat/completions", "groq": "/openai/v1/chat/completions", "together": "/v1/chat/completions",
}

// Asks says whether the server asks this provider (OpenAI format, with the server's key).
func (c Config) Asks(provider string) error {
	if _, ok := chatPaths[provider]; !ok {
		return fmt.Errorf("o provedor %s ainda não roda no servidor", provider)
	}
	if c.Keys[provider] == "" {
		return fmt.Errorf("falta a chave de %s no servidor", provider)
	}
	return nil
}

// SeeWith is the vision model of a provider, as the browser asks it (visionController): the photos as image_url, then the prompt.
func (c Config) SeeWith(provider, model string, maxTokens int, limit time.Duration, spend func(float64)) (See, error) {
	if _, ok := chatPaths[provider]; !ok {
		return nil, fmt.Errorf("o modelo de visão de %s não roda no servidor", provider)
	}
	if err := c.Asks(provider); err != nil {
		return nil, err
	}
	c = c.withDefaults()
	return func(ctx context.Context, images []string, prompt string) (string, error) {
		content := make([]map[string]any, 0, len(images)+1)
		for _, image := range images {
			content = append(content, map[string]any{"type": "image_url", "image_url": map[string]string{"url": image}})
		}
		content = append(content, map[string]any{"type": "text", "text": prompt})
		request, _ := json.Marshal(map[string]any{"model": model, "max_tokens": maxTokens, "messages": []map[string]any{{"role": "user", "content": content}}})
		raw, err := c.post(ctx, c.origin(provider)+chatPaths[provider], c.Keys[provider], "application/json", limit, func() (io.Reader, string) { return strings.NewReader(string(request)), "" }, "o modelo de visão")
		if err != nil {
			return "", err
		}
		return answerOf(raw, spend)
	}, nil
}

func answerOf(raw []byte, spend func(float64)) (string, error) {
	var answer struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Usage struct {
			Cost *float64 `json:"cost"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(raw, &answer); err != nil || len(answer.Choices) == 0 {
		return "", errors.New("a IA respondeu vazio")
	}
	if answer.Usage.Cost != nil && spend != nil {
		spend(*answer.Usage.Cost)
	}
	return answer.Choices[0].Message.Content, nil
}
