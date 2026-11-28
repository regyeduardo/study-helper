// Package generate makes, in Go, what the app's generations make in the browser (src/lib/generation/): the same instructions to the AI
// (the JSON embedded from prompts.data.ts) and the same answers read the same way, so a note made in the account is the note the
// browser would make (T207, FR-084: no Chromium in the server).
package generate

import (
	"context"
	"encoding/json"
	"regexp"
	"strings"
)

// Chat asks the AI: the user's text, the instruction, a limit of tokens for the answer (0: the model's own).
type Chat func(ctx context.Context, user, system string, maxTokens int) (string, error)

// chunkChars is how much of a text goes in one request (src/lib/generation/minutes.ts, CHUNK_CHARS).
const chunkChars = 12000

var fence = regexp.MustCompile("^```[a-zA-Z]*\\n?")

// ExtractJSON is the first JSON object of an answer, fenced or not (src/lib/generation/mermaid.ts, extractJson). Nil: none.
func ExtractJSON(raw string) map[string]any {
	stripped := strings.TrimSpace(raw)
	if strings.HasPrefix(stripped, "```") {
		stripped = strings.TrimSpace(strings.TrimSuffix(fence.ReplaceAllString(stripped, ""), "```"))
	}
	start := strings.Index(stripped, "{")
	if start < 0 {
		return nil
	}
	depth := 0
	for index := start; index < len(stripped); index++ {
		switch stripped[index] {
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				var out map[string]any
				if json.Unmarshal([]byte(stripped[start:index+1]), &out) == nil {
					return out
				}
				return nil
			}
		}
	}
	return nil
}

// head is the start of a text, at most n bytes, never cutting a letter in two.
func head(text string, n int) string {
	if len(text) <= n {
		return text
	}
	return strings.ToValidUTF8(text[:n], "")
}
