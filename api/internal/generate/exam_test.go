package generate

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/regyeduardo/study-helper/api/internal/prompts"
)

// T207: the Prova as src/lib/generation/questions.ts makes it.

func unica(correct string) map[string]any {
	return map[string]any{"enunciado": "Quanto é 2+2?", "alternativas": map[string]any{"A": "1", "B": "2", "C": "3", "D": "4", "E": "5"}, "correta": correct, "explicacao": "Soma.", "nivel": "aplicar",
		"explicacao_das_erradas": map[string]any{"A": " Errada. ", "D": "é a certa", "Z": "x"}, "resposta_certa": "D", "id": 9}
}

func TestOnlyTheQuestionsThatCanBeCheckedAreKept(t *testing.T) {
	items := []any{
		unica("D"),
		map[string]any{"tipo": "unica", "enunciado": "x", "alternativas": map[string]any{"A": "1", "B": "2", "C": "3", "D": "4"}, "correta": "A", "explicacao": "e"},
		map[string]any{"tipo": "multipla", "enunciado": "x", "alternativas": map[string]any{"A": "1", "B": "2", "C": "3", "D": "4", "E": "5"}, "corretas": []any{"A"}, "explicacao": "e"},
		map[string]any{"tipo": "certo_errado", "enunciado": "x", "certo": false, "explicacao": "e", "nivel": "outro"},
		map[string]any{"tipo": "ordenar", "enunciado": "x", "passos": []any{"a", "b", "a"}, "explicacao": "e"},
		map[string]any{"tipo": "lacuna", "enunciado": "O [[1]] é azul", "lacunas": []any{map[string]any{"opcoes": []any{"céu", "mar"}, "correta": "céu"}}, "explicacao": "e"},
		"texto solto",
	}
	kept := ValidateQuestions(items, 5)
	if len(kept) != 3 {
		t.Fatalf("%d %v", len(kept), kept)
	}
	first := kept[0]
	wrong := first["explicacao_das_erradas"].(map[string]any)
	if first["tipo"] != "unica" || first["resposta_certa"] != nil || first["id"] != nil || len(wrong) != 1 || wrong["A"] != "Errada." {
		t.Fatalf("%v", first)
	}
	if kept[1]["nivel"] != nil || kept[1]["tipo"] != "certo_errado" {
		t.Fatalf("%v", kept[1])
	}
	// four alternatives only for the web's questions
	if len(ValidateQuestions(items[1:2], 4)) != 1 {
		t.Fatal("four alternatives")
	}
}

func TestTheRightLetterMovesAndTheExplanationsGoWithIt(t *testing.T) {
	question := ValidateQuestions([]any{unica("D")}, 5)[0]
	calls := 0
	random := func() float64 { calls++; return 0 }
	done := FinishQuestions([]Question{question}, random)[0]
	alternatives := done["alternativas"].(map[string]any)
	right := done["correta"].(string)
	if alternatives[right] != "4" || done["diagrama"] != nil {
		t.Fatalf("%v", done)
	}
	for letter, text := range done["explicacao_das_erradas"].(map[string]any) {
		if alternatives[letter] != "1" || text != "Errada." {
			t.Fatalf("%v", done)
		}
	}
	// a question that reads a diagram that cannot be drawn is dropped; any other keeps going without it
	drawn := FinishQuestions([]Question{{"tipo": "certo_errado", "formato": "interpretar_dado", "diagrama": map[string]any{"tipo": "pie", "dados": map[string]any{}}}, {"tipo": "certo_errado", "diagrama": map[string]any{"tipo": "pie", "dados": map[string]any{"data": []any{map[string]any{"label": "a(1)", "value": 2.5}}}}}}, random)
	if len(drawn) != 1 || drawn[0]["diagrama"] != "pie\n    \"a 1\" : 2.5" {
		t.Fatalf("%v", drawn)
	}
}

func TestTheProvaIsPreparedWrittenReviewedAndFinished(t *testing.T) {
	asked := map[string]string{}
	chat := func(_ context.Context, user, system string, _ int) (string, error) {
		switch {
		case strings.HasPrefix(system, strings.Split(prompts.Text("QUESTIONS_PREP_PROMPT"), "{limite}")[0]):
			asked["prep"] = user
			return "Material preparado.", nil
		case system == prompts.Text("EXAM_REVIEW_PROMPT"):
			asked["review"] = user
			return `{"vereditos": [{"id": 1, "veredito": "mantem"}, {"id": 2, "veredito": "descarta"}]}`, nil
		case strings.HasPrefix(system, prompts.Text("EXAM_PROMPT")):
			asked["exam"] = user
			return `{"questions": [` + mustJSON(unica("D")) + `, {"tipo": "certo_errado", "enunciado": "x", "certo": true, "explicacao": "e"}]}`, nil
		}
		return "", errors.New("instrução desconhecida")
	}
	questions, web, err := Questions(context.Background(), chat, "# Aula\n\nSomas.", "Aula de somas", "class", []Wrong{{Statement: "1+1?", Explanation: "2"}}, nil, "", "foco em somas")
	if err != nil || len(questions) != 1 || web.Found != 0 || !strings.HasPrefix(web.Note, "Sem questões da web: nenhum modelo") {
		t.Fatalf("%v %v %v", questions, web, err)
	}
	if asked["prep"] != "# Aula de somas\n\n# Aula\n\nSomas." || !strings.Contains(asked["exam"], "# Aula de somas\n\nMaterial preparado.\n\n## Questões que a pessoa errou\n\n[{\"enunciado\":\"1+1?\",\"explicacao\":\"2\"}]") || !strings.HasSuffix(asked["exam"], "foco em somas") {
		t.Fatalf("%q", asked)
	}
	if !strings.Contains(ExamPrompt("class", true), prompts.Text("ADAPTIVE_FOCUS")) || ExamPrompt("nada", false) != ExamPrompt("class", false) {
		t.Fatal("prompt")
	}
}

func TestTheWebQuestionsComeWithTheirSourceOrSayWhyNot(t *testing.T) {
	search := func(context.Context, string) (string, error) {
		return `{"questions": [{"tipo": "unica", "enunciado": "x", "alternativas": {"A": "1", "B": "2", "C": "3", "D": "4"}, "correta": "B", "explicacao": "e", "fonte": " https://exemplo.com/prova "}, {"tipo": "certo_errado", "enunciado": "y", "certo": true, "explicacao": "e"}]}`, nil
	}
	found, outcome, _ := WebQuestions(context.Background(), search, "", "assunto")
	if len(found) != 1 || found[0]["fonte"] != "https://exemplo.com/prova" || outcome.Note != "1 questão veio da web, cada uma com a fonte." {
		t.Fatalf("%v %v", found, outcome)
	}
	_, outcome, _ = WebQuestions(context.Background(), func(context.Context, string) (string, error) { return "", errors.New("fora do ar.") }, "", "assunto")
	if outcome.Note != "Sem questões da web: a pesquisa falhou (fora do ar). "+onlyAI {
		t.Fatalf("%q", outcome.Note)
	}
}

func mustJSON(value any) string {
	raw, _ := marshalPlain(value)
	return raw
}
