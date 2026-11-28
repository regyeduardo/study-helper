package generate

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/regyeduardo/study-helper/api/internal/prompts"
)

// T207: the tags of a note, as src/lib/generation/tags.ts suggests them.
func TestTheTagsAreSuggestedAsInTheBrowser(t *testing.T) {
	var asked, system string
	var tokens int
	chat := func(_ context.Context, user, instruction string, maxTokens int) (string, error) {
		asked, system, tokens = user, instruction, maxTokens
		return "```json\n{\"etiquetas\": [\"#Limites\", \"continuidade de funções\", \"limites\", 3, \"a\", \"b\", \"c\"]}\n```", nil
	}
	tags, err := Tags(context.Background(), chat, "  Aula de limites  ", []string{"cálculo", "provas"})
	if err != nil || !reflect.DeepEqual(tags, []string{"limites", "continuidade-de-funções", "a", "b"}) {
		t.Fatalf("%v %v", tags, err)
	}
	if asked != "Etiquetas que a pessoa já usa: cálculo, provas\n\nAula de limites" || system != prompts.Text("TAGS_PROMPT") || tokens != 200 {
		t.Fatalf("%q %d", asked, tokens)
	}
	// nothing to read, or the AI down: no tags, and the note goes on
	if tags, _ := Tags(context.Background(), chat, "   ", nil); tags != nil {
		t.Fatalf("%v", tags)
	}
	down := func(context.Context, string, string, int) (string, error) { return "", errors.New("fora do ar") }
	if tags, err := Tags(context.Background(), down, "texto", nil); tags != nil || err != nil {
		t.Fatalf("%v %v", tags, err)
	}
	if _, err := Tags(context.Background(), func(context.Context, string, string, int) (string, error) { return "", context.Canceled }, "texto", nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("%v", err)
	}
	var none string
	_, _ = Tags(context.Background(), func(_ context.Context, user, _ string, _ int) (string, error) { none = user; return "{}", nil }, strings.Repeat("a", 13000), nil)
	if !strings.HasPrefix(none, "Etiquetas que a pessoa já usa: nenhuma\n\n") || len(none) != len("Etiquetas que a pessoa já usa: nenhuma\n\n")+chunkChars {
		t.Fatalf("%d", len(none))
	}
}
