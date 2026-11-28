package generate

import (
	"context"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/regyeduardo/study-helper/api/internal/prompts"
)

// T207: the map and the cards of a note, as src/lib/generation/mindmap.ts and cards.ts make them.

type scripted struct {
	mu      sync.Mutex
	answers map[string][]string
	asked   []string
}

func (s *scripted) chat(_ context.Context, user, system string, _ int) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.asked = append(s.asked, user)
	for key, list := range s.answers {
		if system == key || strings.Contains(system, key) {
			if len(list) == 0 {
				return "{}", nil
			}
			answer := list[0]
			if len(list) > 1 {
				s.answers[key] = list[1:]
			}
			return answer, nil
		}
	}
	return "{}", nil
}

func TestTheMapOfAShortNoteKeepsTheAIsTreeWithIdsMadeHere(t *testing.T) {
	ai := &scripted{answers: map[string][]string{prompts.Text("MINDMAP_PROMPT"): {`{"nome": "Reajuste do INCC", "forma": "fluxo", "raiz": {"texto": "Reajuste do INCC", "filhos": [{"id": "a", "texto": "Fica em 4,2%", "marca": "✅", "filhos": []}, {"texto": "Refazer a tabela", "ligacoes": [{"para": "a", "rotulo": "depende de"}, {"para": "x"}], "filhos": []}, {"texto": "", "filhos": [{"texto": "Jurídico aprova", "grupo": true, "filhos": []}]}]}}`}}}
	name, diagram, err := Map(context.Background(), ai.chat, "Reunião do reajuste.", "foco no prazo")
	if err != nil || diagram == nil {
		t.Fatal(err)
	}
	root := diagram.Root
	if name != "Reajuste do INCC" || diagram.Form != "fluxo" || len(root.Children) != 3 || root.Children[2].Text != "Jurídico aprova" || !root.Children[2].Group {
		t.Fatalf("%s %+v", name, root)
	}
	decision, task := root.Children[0], root.Children[1]
	if decision.Mark != "✅" || len(task.Links) != 1 || task.Links[0].To != decision.ID || task.Links[0].Label != "depende de" || len(decision.ID) != 36 {
		t.Fatalf("%+v %+v", decision, task)
	}
	if !strings.HasSuffix(ai.asked[0], InstructionHead+"\n\nfoco no prazo") {
		t.Fatalf("%q", ai.asked[0])
	}
}

func TestTheMapOfALongNoteMergesItsPartsWithoutLosingABranch(t *testing.T) {
	ai := &scripted{answers: map[string][]string{
		prompts.Text("MINDMAP_PROMPT"): {
			`{"nome": "Parte 1", "forma": "arvore", "raiz": {"texto": "Curso", "filhos": [{"texto": "Limites", "filhos": [{"texto": "Laterais", "filhos": []}]}, {"texto": "Derivadas", "filhos": []}]}}`,
			`{"nome": "Parte 2", "raiz": {"texto": "Curso", "filhos": [{"texto": "limites!", "filhos": [{"texto": "No infinito", "filhos": []}]}, {"texto": "Integrais", "filhos": []}]}}`,
		},
		prompts.Text("MINDMAP_MERGE_PROMPT"): {`{"nome": "Cálculo 1", "forma": "radial", "raiz": "Cálculo 1 inteiro", "ramos": []}`},
	}}
	name, diagram, err := Map(context.Background(), ai.chat, strings.Repeat("palavra ", 2000), "")
	if err != nil || diagram == nil {
		t.Fatal(err)
	}
	texts := []string{}
	for _, branch := range diagram.Root.Children {
		texts = append(texts, branch.Text)
	}
	// the merge named no branch: all go at the end; "Limites" and "limites!" are the same and become one with both children
	if name != "Cálculo 1" || diagram.Root.Text != "Cálculo 1 inteiro" || strings.Join(texts, "|") != "Limites|Derivadas|Integrais" || len(diagram.Root.Children[0].Children) != 2 {
		t.Fatalf("%s %s %v", name, diagram.Root.Text, texts)
	}
	if !strings.Contains(ai.asked[2], `"ramos":[{"id":"`) {
		t.Fatalf("%q", ai.asked[2])
	}
}

func TestTheCardsTakeFromEveryPartAndTheDeckIsNamed(t *testing.T) {
	ai := &scripted{answers: map[string][]string{
		prompts.Text("CARDS_PROMPT"): {`{"cartoes": [{"frente": "O que é limite?", "verso": "O valor de que f se aproxima."}, {"frente": " ", "verso": "x"}]}`},
		"Você dá nome a um material": {`{"nome": "\"Limites de funções.\""}`},
	}}
	cards, name, err := Cards(context.Background(), ai.chat, "Limites.", "", "2026-11-28")
	if err != nil || len(cards) != 1 || cards[0].Front != "O que é limite?" || cards[0].Box != 0 || cards[0].Due != "2026-11-28" || name != "Limites de funções" {
		t.Fatalf("%+v %q %v", cards, name, err)
	}
	if got := spread([][]Card{{{ID: "a"}, {ID: "b"}, {ID: "c"}}, {{ID: "d"}}}, 3); len(got) != 3 || got[0].ID != "a" || got[1].ID != "b" || got[2].ID != "d" {
		t.Fatalf("%+v", got)
	}
}

// the name instruction lives in the app's code, not in prompts.data.ts: the two must say the same
func TestTheNameInstructionIsTheAppsOwn(t *testing.T) {
	raw, err := os.ReadFile("../../../src/lib/generation/artifact-name.ts")
	if err != nil {
		t.Skip("sem o código do app aqui")
	}
	if !strings.Contains(string(raw), "export const NAME_PROMPT = `"+namePrompt+"`") {
		t.Fatal("NAME_PROMPT mudou no app: copie para o Go")
	}
}

func TestTheWebQuestionsInstructionIsTheAppsOwn(t *testing.T) {
	raw, err := os.ReadFile("../../../src/lib/generation/web-questions.ts")
	if err != nil {
		t.Skip("sem o código do app aqui")
	}
	if !strings.Contains(string(raw), "export const WEB_QUESTIONS_PROMPT = `"+webQuestionsPrompt+"`") {
		t.Fatal("WEB_QUESTIONS_PROMPT mudou no app: copie para o Go")
	}
}
