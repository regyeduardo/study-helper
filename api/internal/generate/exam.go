package generate

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/regyeduardo/study-helper/api/internal/prompts"
)

// The Prova of a note (src/lib/generation/questions.ts, exam-questions.ts, web-questions.ts).

// Question is a question as the AI writes it (RawQuestion).
type Question = map[string]any

const (
	maxQuestionInput = 40000
	examAttempts     = 3
	longReply        = 32768
	examMin, examMax = 12, 15
	onlyAI           = "A prova saiu só com questões criadas pela IA."
)

var (
	examLetters    = []string{"A", "B", "C", "D", "E"}
	questionKinds  = []string{"unica", "multipla", "certo_errado", "ordenar", "associar", "lacuna"}
	questionLevels = []string{"lembrar", "aplicar", "analisar"}
	internalFields = []string{"resposta_certa", "erro_de_cada_errada", "id"}
	webSource      = regexp.MustCompile(`^https?://\S+$`)
	noWebModel     = "Sem questões da web: nenhum modelo que pesquise na web em Configurações › Inteligência artificial › Padrões por uso › Questões da web. " + onlyAI
)

func contains(list []string, value any) bool {
	text, ok := value.(string)
	if !ok {
		return false
	}
	for _, item := range list {
		if item == text {
			return true
		}
	}
	return false
}

func filled(value any) bool {
	text, ok := value.(string)
	return ok && strings.TrimSpace(text) != ""
}

// sameValue is JavaScript's === between two JSON values (objects and arrays are never the same).
func sameValue(a, b any) bool {
	switch a.(type) {
	case nil, string, float64, bool:
		switch b.(type) {
		case nil, string, float64, bool:
			return a == b
		}
	}
	return false
}

func lettersOf(question Question, fewest int) []string {
	alternatives, ok := question["alternativas"].(map[string]any)
	if !ok {
		return nil
	}
	used := examLetters[:fewest]
	if filled(alternatives["E"]) {
		used = examLetters
	}
	for _, letter := range used {
		if !filled(alternatives[letter]) {
			return nil
		}
	}
	return used
}

func problemOf(question Question, fewest int) string {
	kind, _ := question["tipo"].(string)
	if !contains(questionKinds, kind) {
		return "tipo desconhecido: " + jsText(question["tipo"])
	}
	if !filled(question["enunciado"]) {
		return "sem enunciado"
	}
	if !filled(question["explicacao"]) {
		return "sem explicação"
	}
	switch kind {
	case "unica":
		letters := lettersOf(question, fewest)
		if letters == nil {
			return fmt.Sprintf("não tem as %d alternativas", fewest)
		}
		if !contains(letters, question["correta"]) {
			return "sem letra correta válida"
		}
	case "multipla":
		used := lettersOf(question, fewest)
		if used == nil {
			return fmt.Sprintf("não tem as %d alternativas", fewest)
		}
		letters, ok := question["corretas"].([]any)
		distinct := map[any]bool{}
		every := ok
		for _, letter := range letters {
			if !contains(used, letter) {
				every = false
			}
			if sameValue(letter, letter) {
				distinct[letter] = true
			}
		}
		if !every || len(distinct) < 2 || len(distinct) > 4 {
			return "marque todas sem 2 a 4 letras corretas válidas"
		}
	case "certo_errado":
		if _, ok := question["certo"].(bool); !ok {
			return "certo/errado sem gabarito"
		}
	case "ordenar":
		steps, ok := question["passos"].([]any)
		if !ok || len(steps) < 3 {
			return "ordenar com menos de 3 passos"
		}
		seen := map[string]bool{}
		for _, step := range steps {
			if !filled(step) {
				return "ordenar com menos de 3 passos"
			}
			seen[step.(string)] = true
		}
		if len(seen) != len(steps) {
			return "ordenar com passo repetido"
		}
	case "associar":
		pairs, ok := question["pares"].([]any)
		if !ok || len(pairs) < 3 {
			return "associar com menos de 3 pares"
		}
		rights := map[string]bool{}
		for _, item := range pairs {
			pair, ok := item.(map[string]any)
			if !ok || !filled(pair["esquerda"]) || !filled(pair["direita"]) {
				return "associar com par incompleto"
			}
			rights[pair["direita"].(string)] = true
		}
		if len(rights) != len(pairs) {
			return "associar com definição repetida"
		}
	case "lacuna":
		gaps, ok := question["lacunas"].([]any)
		if !ok || len(gaps) == 0 {
			return "lacuna sem lacunas"
		}
		statement, _ := question["enunciado"].(string)
		for number := 1; number <= len(gaps); number++ {
			if !strings.Contains(statement, "[["+strconv.Itoa(number)+"]]") {
				return fmt.Sprintf("lacuna [[%d]] fora do enunciado", number)
			}
			gap, _ := gaps[number-1].(map[string]any)
			options, ok := gap["opcoes"].([]any)
			found := false
			for _, option := range options {
				if sameValue(option, gap["correta"]) {
					found = true
				}
			}
			if !ok || len(options) < 2 || !found {
				return fmt.Sprintf("lacuna %d sem a opção certa entre as opções", number)
			}
		}
	}
	return ""
}

func cleanQuestion(question Question) Question {
	out := Question{}
	for key, value := range question {
		if !contains(internalFields, key) {
			out[key] = value
		}
	}
	if !contains(questionLevels, out["nivel"]) {
		out["nivel"] = nil
	}
	wrong, isObject := out["explicacao_das_erradas"].(map[string]any)
	kind := question["tipo"]
	if (kind == "unica" || kind == "multipla") && isObject {
		right := map[string]bool{}
		if kind == "unica" {
			right[jsText(question["correta"])] = true
		} else {
			for _, letter := range question["corretas"].([]any) {
				right[jsText(letter)] = true
			}
		}
		kept := map[string]any{}
		for letter, value := range wrong {
			if filled(value) && contains(examLetters, letter) && !right[letter] {
				kept[letter] = strings.TrimSpace(value.(string))
			}
		}
		out["explicacao_das_erradas"] = kept
	} else {
		delete(out, "explicacao_das_erradas")
	}
	return out
}

// ValidateQuestions keeps the questions that can be answered and checked; `fewest` 4 keeps a question of four alternatives (the web's).
func ValidateQuestions(items []any, fewest int) []Question {
	accepted := []Question{}
	for _, item := range items {
		raw, ok := item.(map[string]any)
		if !ok {
			continue
		}
		question := Question{}
		for key, value := range raw {
			question[key] = value
		}
		if !truthy(raw["tipo"]) {
			question["tipo"] = "unica"
		}
		if problemOf(question, fewest) != "" {
			continue
		}
		accepted = append(accepted, cleanQuestion(question))
	}
	return accepted
}

// extractQuestions is the list `questions` of an answer (pipeline.ts).
func extractQuestions(raw string) []any {
	trimmed := strings.TrimSpace(raw)
	var payload map[string]any
	if json.Unmarshal([]byte(trimmed), &payload) != nil {
		payload = ExtractJSON(trimmed)
	}
	list, _ := payload["questions"].([]any)
	return list
}

func withDiagram(question Question) Question {
	out := Question{}
	for key, value := range question {
		out[key] = value
	}
	spec, ok := question["diagrama"].(map[string]any)
	if !ok {
		out["diagrama"] = nil
		return out
	}
	code, err := Diagram(jsText(spec["tipo"]), spec["dados"])
	if err != nil {
		if question["formato"] == "interpretar_dado" {
			return nil
		}
		out["diagrama"] = nil
		return out
	}
	out["diagrama"] = code
	return out
}

func shuffled(items []string, random func() float64) []string {
	out := append([]string(nil), items...)
	for index := len(out) - 1; index > 0; index-- {
		other := int(random() * float64(index+1))
		out[index], out[other] = out[other], out[index]
	}
	return out
}

func drawnLetter(question Question) bool {
	return question["tipo"] == "unica" && question["formato"] != "assercao_razao"
}

func presentLetters(question Question) []string {
	alternatives, _ := question["alternativas"].(map[string]any)
	out := []string{}
	for _, letter := range examLetters {
		if filled(alternatives[letter]) {
			out = append(out, letter)
		}
	}
	return out
}

func relabel(question Question, order []string) Question {
	newLetter := map[string]string{}
	for index, old := range order {
		newLetter[old] = examLetters[index]
	}
	out := Question{}
	for key, value := range question {
		out[key] = value
	}
	alternatives, _ := question["alternativas"].(map[string]any)
	moved := map[string]any{}
	for _, old := range order {
		moved[newLetter[old]] = alternatives[old]
	}
	out["alternativas"] = moved
	if question["tipo"] == "unica" {
		out["correta"] = newLetter[jsText(question["correta"])]
	} else {
		letters := []string{}
		for _, letter := range question["corretas"].([]any) {
			letters = append(letters, newLetter[jsText(letter)])
		}
		sort.Strings(letters)
		corretas := make([]any, len(letters))
		for i, letter := range letters {
			corretas[i] = letter
		}
		out["corretas"] = corretas
	}
	if wrong, ok := question["explicacao_das_erradas"].(map[string]any); ok {
		relabeled := map[string]any{}
		for letter, value := range wrong {
			relabeled[newLetter[letter]] = value
		}
		out["explicacao_das_erradas"] = relabeled
	}
	return out
}

// FinishQuestions draws the diagrams and moves the right letters so that each letter is right about as often (finishQuestions).
func FinishQuestions(questions []Question, random func() float64) []Question {
	if random == nil {
		random = rand.Float64
	}
	built := []Question{}
	drawn := 0
	for _, question := range questions {
		if done := withDiagram(question); done != nil {
			built = append(built, done)
			if drawnLetter(done) {
				drawn++
			}
		}
	}
	targets := []string{}
	for len(targets) < drawn {
		targets = append(targets, shuffled(examLetters, random)...)
	}
	targets = shuffled(targets[:drawn], random)
	out := make([]Question, len(built))
	for index, question := range built {
		switch {
		case drawnLetter(question):
			target := targets[len(targets)-1]
			targets = targets[:len(targets)-1]
			right := jsText(question["correta"])
			others := []string{}
			for _, letter := range presentLetters(question) {
				if letter != right {
					others = append(others, letter)
				}
			}
			others = shuffled(others, random)
			at := min(indexOf(examLetters, target), len(others))
			others = append(others[:at], append([]string{right}, others[at:]...)...)
			out[index] = relabel(question, others)
		case question["tipo"] == "multipla":
			out[index] = relabel(question, shuffled(presentLetters(question), random))
		default:
			out[index] = question
		}
	}
	return out
}

func indexOf(list []string, value string) int {
	for i, item := range list {
		if item == value {
			return i
		}
	}
	return -1
}

// ReviewQuestions: the AI judges each question (keeps, fixes or drops it); the AI down keeps them as they were.
func ReviewQuestions(ctx context.Context, chat Chat, questions []Question) ([]Question, error) {
	if len(questions) == 0 {
		return questions, nil
	}
	numbered := make([]Question, len(questions))
	for index, question := range questions {
		copied := Question{}
		for key, value := range question {
			copied[key] = value
		}
		copied["id"] = index + 1
		numbered[index] = copied
	}
	request, _ := marshalPlain(map[string]any{"questions": numbered})
	raw, err := chat(ctx, request, prompts.Text("EXAM_REVIEW_PROMPT"), longReply)
	if err != nil {
		if cancelled(ctx, err) {
			return nil, err
		}
		return questions, nil
	}
	var payload map[string]any
	if json.Unmarshal([]byte(raw), &payload) != nil {
		payload = ExtractJSON(raw)
	}
	items, ok := payload["vereditos"].([]any)
	if !ok {
		return questions, nil
	}
	verdicts := map[int]map[string]any{}
	for _, item := range items {
		verdict, ok := item.(map[string]any)
		id, isNumber := verdict["id"].(float64)
		if ok && isNumber && id == float64(int(id)) {
			verdicts[int(id)] = verdict
		}
	}
	kept := []Question{}
	for index, question := range questions {
		verdict := verdicts[index+1]
		if verdict["veredito"] == "descarta" {
			continue
		}
		if fixed, ok := verdict["questao"].(map[string]any); verdict["veredito"] == "corrige" && ok {
			copied := Question{}
			for key, value := range fixed {
				copied[key] = value
			}
			if !truthy(fixed["tipo"]) {
				copied["tipo"] = question["tipo"]
			}
			kept = append(kept, copied)
			continue
		}
		kept = append(kept, question)
	}
	return kept, nil
}

func prepPrompt(materialChars int) string {
	limit := max(prompts.Int("PREP_MIN_CHARS"), min(prompts.Int("PREP_MAX_CHARS"), materialChars/3))
	return strings.Replace(prompts.Text("QUESTIONS_PREP_PROMPT"), "{limite}", strconv.Itoa(limit), 1)
}

// ExamPrompt is the instruction of a Prova for the type of the note; `adaptive`: a Reforço of the questions the person got wrong.
func ExamPrompt(fileType string, adaptive bool) string {
	focus := prompts.Entry("FILE_TYPE_FOCUS", fileType)
	if focus == "" {
		focus = prompts.Entry("FILE_TYPE_FOCUS", "class")
	}
	schemas := []string{}
	for _, kind := range []string{"flowchart", "sequence", "state", "pie"} {
		schemas = append(schemas, prompts.Entry("DIAGRAM_SCHEMAS", kind))
	}
	parts := []string{prompts.Text("EXAM_PROMPT"), focus, prompts.Text("EXAM_FORMATS"), prompts.Text("ALTERNATIVE_RULES"), prompts.Text("WRONG_FROM_REAL_ERRORS"), prompts.Text("EXAM_DIAGRAMS"), strings.Join(schemas, "\n"), prompts.Text("EXAM_JSON"), prompts.Text("EXAM_SELF_CONTAINED")}
	if adaptive {
		parts = append(parts, prompts.Text("ADAPTIVE_FOCUS"))
	}
	return strings.Join(parts, "\n")
}

func truncateForQuestions(markdown string) string {
	runes := []rune(markdown)
	if len(runes) <= maxQuestionInput {
		return markdown
	}
	cut := strings.LastIndex(string(runes[:min(len(runes), maxQuestionInput+4)]), "\n## ")
	if cut >= 0 {
		cut = len([]rune(string(runes[:min(len(runes), maxQuestionInput+4)])[:cut]))
	}
	if cut < 0 || cut > maxQuestionInput {
		cut = maxQuestionInput
	}
	return strings.TrimSpace(string(runes[:cut]))
}

func askForQuestions(ctx context.Context, chat Chat, content, system string) ([]Question, error) {
	for attempt := 1; attempt <= examAttempts; attempt++ {
		raw, err := chat(ctx, content, system, longReply)
		if err != nil {
			return nil, err
		}
		if questions := ValidateQuestions(extractQuestions(raw), 5); len(questions) > 0 {
			return questions, nil
		}
	}
	return []Question{}, nil
}

func questionsWord(count int) string {
	if count == 1 {
		return "questão"
	}
	return "questões"
}

func webRoom(found int) string {
	most := examMax - found
	least := max(1, examMin-found)
	span := fmt.Sprintf("de %d a %d", least, most)
	if least == most {
		span = strconv.Itoa(most)
	}
	real := "questões reais tiradas"
	if found == 1 {
		real = "questão real tirada"
	}
	return fmt.Sprintf("\n## QUESTÕES DA WEB\nA prova já tem %d %s da web (listadas no fim do conteúdo). Crie só as que faltam: %s %s, no lugar de \"de %d a %d\", variando os formatos sem precisar usar todos. Não repita o que as da web já perguntam.", found, real, span, questionsWord(most), examMin, examMax)
}

// WebOutcome is what the web gave the Prova: how many questions and the line that tells the person.
type WebOutcome struct {
	Found int    `json:"found"`
	Note  string `json:"note"`
}

// WebSearch asks the Questões da web model; nil: none can search.
type WebSearch func(ctx context.Context, subject string) (string, error)

// WebQuestions are the real exam questions the web model found, each with its source; it never fails the Prova (only a cancel).
func WebQuestions(ctx context.Context, search WebSearch, cannot, subject string) ([]Question, WebOutcome, error) {
	none := func(note string) ([]Question, WebOutcome, error) {
		return []Question{}, WebOutcome{Found: 0, Note: note}, nil
	}
	if cannot != "" {
		return none(cannot)
	}
	if search == nil {
		return none(noWebModel)
	}
	raw, err := search(ctx, subject)
	if err != nil {
		if cancelled(ctx, err) {
			return nil, WebOutcome{}, err
		}
		return none("Sem questões da web: a pesquisa falhou (" + strings.TrimSuffix(strings.TrimSpace(err.Error()), ".") + "). " + onlyAI)
	}
	sourced := []any{}
	for _, item := range extractQuestions(raw) {
		row, ok := item.(map[string]any)
		source, isText := row["fonte"].(string)
		if !ok || !isText || !webSource.MatchString(strings.TrimSpace(source)) {
			continue
		}
		copied := map[string]any{}
		for key, value := range row {
			copied[key] = value
		}
		copied["fonte"] = strings.TrimSpace(source)
		sourced = append(sourced, copied)
	}
	questions := ValidateQuestions(sourced, 4)
	if len(questions) == 0 {
		return none("Sem questões da web: a pesquisa não achou questões reais sobre o assunto. " + onlyAI)
	}
	came := "questões vieram"
	if len(questions) == 1 {
		came = "questão veio"
	}
	return questions, WebOutcome{Found: len(questions), Note: fmt.Sprintf("%d %s da web, cada uma com a fonte.", len(questions), came)}, nil
}

// Wrong is a question the person got wrong (WrongQuestion).
type Wrong struct {
	Statement   string `json:"enunciado"`
	Explanation string `json:"explicacao"`
}

// Questions are the questions of a Prova of the note (generateQuestions): the material prepared, the web's real questions first, the AI
// writing the rest, reviewed, checked and finished.
func Questions(ctx context.Context, chat Chat, markdown, title, fileType string, wrong []Wrong, search WebSearch, cannotSearch, instruction string) ([]Question, WebOutcome, error) {
	trimmed := truncateForQuestions(markdown)
	prep, err := chat(ctx, "# "+title+"\n\n"+trimmed, prepPrompt(len([]rune(trimmed))), 0)
	if err != nil {
		return nil, WebOutcome{}, err
	}
	if prep = strings.TrimSpace(prep); prep == "" {
		prep = trimmed
	}
	subject := "# " + title + "\n\n" + prep
	found, outcome, err := WebQuestions(ctx, search, cannotSearch, subject)
	if err != nil {
		return nil, outcome, err
	}
	if len(found) >= examMax {
		return FinishQuestions(found, nil), outcome, nil
	}
	content := subject
	if len(wrong) > 0 {
		raw, _ := marshalPlain(wrong)
		content += "\n\n## Questões que a pessoa errou\n\n" + raw
	}
	system := ExamPrompt(fileType, len(wrong) > 0)
	if len(found) > 0 {
		statements := []any{}
		for _, question := range found {
			statements = append(statements, question["enunciado"])
		}
		raw, _ := marshalPlain(statements)
		content += "\n\n## Questões da web que já estão na prova\n\n" + raw
		system += webRoom(len(found))
	}
	asked, err := askForQuestions(ctx, chat, WithInstruction(content, instruction), system)
	if err != nil {
		return nil, outcome, err
	}
	reviewed, err := ReviewQuestions(ctx, chat, asked)
	if err != nil {
		return nil, outcome, err
	}
	items := make([]any, len(reviewed))
	for i, question := range reviewed {
		items[i] = question
	}
	checked := ValidateQuestions(items, 5)
	for _, question := range checked {
		delete(question, "fonte")
	}
	return FinishQuestions(append(found, checked...), nil), outcome, nil
}
