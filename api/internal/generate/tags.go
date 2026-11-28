package generate

import (
	"context"
	"errors"
	"regexp"
	"strings"

	"github.com/regyeduardo/study-helper/api/internal/prompts"
)

const (
	mostTags   = 4
	tagsTokens = 200
)

var spaces = regexp.MustCompile(`\s+`)

func cleanedTag(tag string) string {
	return spaces.ReplaceAllString(strings.ToLower(strings.TrimPrefix(strings.TrimSpace(tag), "#")), "-")
}

// Tags suggests up to 4 tags for a note (src/lib/generation/tags.ts): the AI down gives none, and the note goes on.
func Tags(ctx context.Context, chat Chat, content string, known []string) ([]string, error) {
	text := head(strings.TrimSpace(content), chunkChars)
	if text == "" {
		return nil, nil
	}
	using := "nenhuma"
	if len(known) > 0 {
		using = strings.Join(known, ", ")
	}
	answer, err := chat(ctx, "Etiquetas que a pessoa já usa: "+using+"\n\n"+text, prompts.Text("TAGS_PROMPT"), tagsTokens)
	if err != nil {
		if errors.Is(err, context.Canceled) || ctx.Err() != nil {
			return nil, err
		}
		return nil, nil
	}
	list, _ := ExtractJSON(answer)["etiquetas"].([]any)
	out := []string{}
	seen := map[string]bool{}
	for _, item := range list {
		tag, ok := item.(string)
		if !ok {
			continue
		}
		if tag = cleanedTag(tag); tag != "" && !seen[tag] {
			seen[tag] = true
			out = append(out, tag)
		}
	}
	if len(out) == 0 {
		return nil, nil
	}
	return out[:min(mostTags, len(out))], nil
}
