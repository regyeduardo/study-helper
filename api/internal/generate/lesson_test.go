package generate

import (
	"context"
	"strings"
	"sync"
	"testing"

	"github.com/regyeduardo/study-helper/api/internal/prompts"
)

// T207: the Aula and the Explicação as src/lib/generation/pipeline.ts writes them.
func TestALessonIsCheckedAskedAgainWithTheErrorAndItsDiagramsDrawn(t *testing.T) {
	var mu sync.Mutex
	tries := 0
	systems := []string{}
	chat := func(_ context.Context, user, system string, _ int) (string, error) {
		mu.Lock()
		defer mu.Unlock()
		if system == prompts.Text("DIAGRAM_PROMPT") {
			if strings.Contains(user, "O diagrama deve mostrar: Etapas. Entrada, saída") {
				return `{"nada": true}`, nil
			}
			return `{"nodes": [{"id": "a", "text": "Início"}], "links": []}`, nil
		}
		tries++
		systems = append(systems, system)
		if tries == 1 {
			return `{"markdown": {"elements": [{"type": "heading", "text": "Aula", "level": 9}]}}`, nil
		}
		return "```json\n" + `{"markdown": {"elements": [
			{"type": "heading", "text": "Limites", "level": 1},
			{"type": "paragraph", "text": "Veja [a fonte](https://exemplo.com) e www.site.com ."},
			{"type": "diagram", "diagramIndex": 0},
			{"type": "diagram", "diagramIndex": 1},
			{"type": "alert", "style": "tip", "text": "Dica\nboa"},
			{"type": "table", "headers": ["a", "b"], "rows": [["1"]]},
			{"type": "codeBlock", "language": "go", "text": "x := \"https://exemplo.com\""}
		], "diagrams": [{"type": "flowchart", "hint": "Fluxo"}, {"type": "flowchart", "hint": "Etapas. Entrada, saída"}]}}` + "\n```", nil
	}
	markdown, err := Content(context.Background(), chat, "Material", "ESCREVA A AULA")
	if err != nil {
		t.Fatal(err)
	}
	if tries != 2 || !strings.Contains(systems[1], "[Auto-Correção]\nErro na tentativa anterior: elemento[0] (heading) precisa de 'level' entre 1 e 6\n--- PROMPT ORIGINAL (não modificar) ---\nESCREVA A AULA") {
		t.Fatalf("%d %q", tries, systems)
	}
	want := "# Limites\n\nVeja a fonte e.\n\n```mermaid\nflowchart TD\na[\"Início\"]\n```\n\n| Conceito | Descrição |\n|----------|-----------|\n| Etapas | |\n| Entrada, | saída |\n\n> [!TIP]\n> Dica\n> boa\n\n| a | b |\n|---|---|\n| 1 | |\n\n```go\nx := \"https://exemplo.com\"\n```\n"
	if markdown != want {
		t.Fatalf("%q\n%q", markdown, want)
	}
}
