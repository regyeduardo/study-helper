package generate

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"github.com/regyeduardo/study-helper/api/internal/prompts"
)

// The writer of the Aula and the Explicação (src/lib/generation/pipeline.ts, markdown-builder.ts, diagram-prompt.ts, table-fallback.ts,
// links.ts): the AI gives the lesson as elements, checked here (asked again with the error, up to 5 times); then each diagram is asked
// on its own, at once, and one that does not come becomes a table.

const (
	phaseOneTries = 5
	phaseTwoTries = 3
)

var (
	elementTypes = map[string]bool{"heading": true, "paragraph": true, "bulletedList": true, "orderedList": true, "checklist": true, "blockquote": true, "codeBlock": true, "table": true, "alert": true, "horizontalRule": true, "details": true, "diagram": true}
	alertStyles  = map[string]string{"note": "NOTE", "tip": "TIP", "important": "IMPORTANT", "warning": "WARNING", "caution": "CAUTION"}
	diagramTypes = []string{"flowchart", "sequence", "class", "state", "pie", "gantt", "mindmap"}
)

// Element is an element of a lesson as the AI writes it.
type Element = map[string]any

// DiagramSlot is a diagram the lesson asks for: its type and what it shows.
type DiagramSlot struct {
	Type string
	Hint string
}

// LessonError is a lesson answer that does not hold (it goes back to the AI with the reason).
type LessonError struct{ reason string }

func (e *LessonError) Error() string { return e.reason }

func lessonError(format string, args ...any) error { return &LessonError{fmt.Sprintf(format, args...)} }

func filledText(value any) bool { return strings.TrimSpace(jsText(value)) != "" }

func nonEmpty(value any) bool {
	if list, ok := value.([]any); ok {
		return len(list) > 0
	}
	return truthy(value)
}

func integer(value any) (int, bool) {
	number, ok := value.(float64)
	if !ok || number != float64(int(number)) {
		return 0, false
	}
	return int(number), true
}

func jsonOf(value any) string {
	if value == nil {
		return "null"
	}
	raw, _ := marshalPlain(value)
	return raw
}

func validateElement(index int, element Element, diagrams []any) error {
	kind := jsText(element["type"])
	switch kind {
	case "heading":
		if !filledText(element["text"]) {
			return lessonError("elemento[%d] (heading) sem 'text'", index)
		}
		if level, ok := integer(element["level"]); !ok || level < 1 || level > 6 {
			return lessonError("elemento[%d] (heading) precisa de 'level' entre 1 e 6", index)
		}
	case "paragraph", "blockquote", "codeBlock":
		if !filledText(element["text"]) {
			return lessonError("elemento[%d] (%s) sem 'text'", index, kind)
		}
	case "bulletedList", "orderedList":
		if !nonEmpty(element["items"]) {
			return lessonError("elemento[%d] (%s) sem 'items'", index, kind)
		}
	case "checklist":
		if !nonEmpty(element["checkItems"]) {
			return lessonError("elemento[%d] (checklist) sem 'checkItems'", index)
		}
	case "table":
		if !nonEmpty(element["headers"]) {
			return lessonError("elemento[%d] (table) sem 'headers'", index)
		}
		if !nonEmpty(element["rows"]) {
			return lessonError("elemento[%d] (table) sem 'rows'", index)
		}
	case "alert":
		if !filledText(element["text"]) {
			return lessonError("elemento[%d] (alert) sem 'text'", index)
		}
	case "details":
		if !filledText(element["summary"]) {
			return lessonError("elemento[%d] (details) sem 'summary'", index)
		}
		if !filledText(element["text"]) {
			return lessonError("elemento[%d] (details) sem 'text'", index)
		}
	case "diagram":
		if at, ok := integer(element["diagramIndex"]); !ok || at < 0 || at >= len(diagrams) {
			return lessonError("elemento[%d] (diagram) tem diagramIndex fora dos limites: %s", index, jsonOf(element["diagramIndex"]))
		}
	}
	return nil
}

// ValidateLesson checks the AI's lesson: its elements and the diagrams they point to.
func ValidateLesson(payload map[string]any) ([]Element, []DiagramSlot, error) {
	markdown, ok := payload["markdown"].(map[string]any)
	if !ok {
		return nil, nil, lessonError("resposta sem o objeto 'markdown'")
	}
	items, ok := markdown["elements"].([]any)
	if !ok || len(items) == 0 {
		return nil, nil, lessonError("'elements' vazio ou ausente")
	}
	diagrams := []any{}
	if raw, present := markdown["diagrams"]; present && raw != nil {
		list, ok := raw.([]any)
		if !ok {
			return nil, nil, lessonError("'diagrams' precisa ser uma lista")
		}
		diagrams = list
	}
	elements := make([]Element, len(items))
	for index, item := range items {
		element, ok := item.(map[string]any)
		if !ok {
			return nil, nil, lessonError("elemento[%d] não é um objeto", index)
		}
		if !elementTypes[jsText(element["type"])] {
			return nil, nil, lessonError("elemento[%d] tem tipo desconhecido: '%s'", index, jsText(element["type"]))
		}
		if err := validateElement(index, element, diagrams); err != nil {
			return nil, nil, err
		}
		elements[index] = element
	}
	slots := make([]DiagramSlot, len(diagrams))
	for index, item := range diagrams {
		slot, ok := item.(map[string]any)
		if !ok {
			return nil, nil, lessonError("diagrama[%d] não é um objeto", index)
		}
		if !contains(diagramTypes, jsText(slot["type"])) {
			return nil, nil, lessonError("diagrama[%d] tem tipo inválido: '%s'", index, jsText(slot["type"]))
		}
		if !filledText(slot["hint"]) {
			return nil, nil, lessonError("diagrama[%d] está sem 'hint'", index)
		}
		slots[index] = DiagramSlot{Type: jsText(slot["type"]), Hint: jsText(slot["hint"])}
	}
	return elements, slots, nil
}

func renderDiagram(element Element, resolved []string, placeholders bool) string {
	index, _ := integer(element["diagramIndex"])
	if placeholders || resolved == nil {
		return "<!-- diagram:" + strconv.Itoa(index) + " -->"
	}
	if index >= len(resolved) {
		return ""
	}
	content := resolved[index]
	if strings.HasPrefix(strings.TrimLeft(content, " \t\n\r"), "|") {
		return content
	}
	return "```mermaid\n" + content + "\n```"
}

func quoted(value any) string {
	lines := strings.Split(jsText(value), "\n")
	for i, line := range lines {
		lines[i] = "> " + line
	}
	return strings.Join(lines, "\n")
}

func anyList(value any) []any {
	list, _ := value.([]any)
	return list
}

func renderTable(element Element) string {
	headers := []string{}
	for _, header := range anyList(element["headers"]) {
		headers = append(headers, jsText(header))
	}
	dashes := make([]string, len(headers))
	for i := range dashes {
		dashes[i] = "---"
	}
	lines := []string{"| " + strings.Join(headers, " | ") + " |", "|" + strings.Join(dashes, "|") + "|"}
	for _, row := range anyList(element["rows"]) {
		cells := []string{}
		for _, cell := range anyList(row) {
			cells = append(cells, jsText(cell))
		}
		for len(cells) < len(headers) {
			cells = append(cells, "")
		}
		lines = append(lines, "| "+strings.Join(cells[:len(headers)], " | ")+" |")
	}
	return strings.Join(lines, "\n")
}

func renderElement(element Element) string {
	switch jsText(element["type"]) {
	case "heading":
		level, _ := integer(element["level"])
		return strings.Repeat("#", level) + " " + jsText(element["text"])
	case "paragraph":
		return jsText(element["text"])
	case "bulletedList":
		lines := []string{}
		for _, item := range anyList(element["items"]) {
			lines = append(lines, "- "+jsText(item))
		}
		return strings.Join(lines, "\n")
	case "orderedList":
		lines := []string{}
		for position, item := range anyList(element["items"]) {
			lines = append(lines, strconv.Itoa(position+1)+". "+jsText(item))
		}
		return strings.Join(lines, "\n")
	case "checklist":
		lines := []string{}
		for _, raw := range anyList(element["checkItems"]) {
			item, _ := raw.(map[string]any)
			mark := " "
			if truthy(item["checked"]) {
				mark = "x"
			}
			lines = append(lines, "- ["+mark+"] "+jsText(item["text"]))
		}
		return strings.Join(lines, "\n")
	case "blockquote":
		return quoted(element["text"])
	case "codeBlock":
		return "```" + jsText(element["language"]) + "\n" + jsText(element["text"]) + "\n```"
	case "table":
		return renderTable(element)
	case "alert":
		style, ok := alertStyles[strings.ToLower(jsText(or(element["style"], "note")))]
		if !ok {
			style = "NOTE"
		}
		return "> [!" + style + "]\n" + quoted(element["text"])
	case "horizontalRule":
		return "---"
	case "details":
		return "<details><summary>" + jsText(element["summary"]) + "</summary>\n\n" + jsText(element["text"]) + "\n\n</details>"
	}
	return ""
}

// BuildMarkdown writes the lesson; `placeholders`: the diagrams still to come as marks.
func BuildMarkdown(elements []Element, resolved []string, placeholders bool) string {
	blocks := []string{}
	for _, element := range elements {
		block := ""
		if element["type"] == "diagram" {
			block = renderDiagram(element, resolved, placeholders)
		} else {
			block = renderElement(element)
		}
		if block != "" {
			blocks = append(blocks, block)
		}
	}
	return StripExternalLinks(strings.TrimSpace(strings.Join(blocks, "\n\n")) + "\n")
}

var (
	fenced       = regexp.MustCompile("(```[\\s\\S]*?```|~~~[\\s\\S]*?~~~|`[^`\\n]*`)")
	markdownLink = regexp.MustCompile(`\[([^\]\n]*)\]\(\s*([^)\s]+)[^)]*\)`)
	angleURL     = regexp.MustCompile(`<\s*(https?://[^>\s]+)\s*>`)
	bareURL      = regexp.MustCompile(`(?:https?://|www\.)[^\s<>)\]]+`)
	externalLink = regexp.MustCompile(`(?i)^(https?://|www\.|//)`)
	manySpaces   = regexp.MustCompile(`[ \t]{2,}`)
	spaceBefore  = regexp.MustCompile(` +([,.;:!?])`)
)

func wordByte(b byte) bool {
	return b == '_' || (b >= '0' && b <= '9') || (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z')
}

func cleanLinks(text string) string {
	text = markdownLink.ReplaceAllStringFunc(text, func(whole string) string {
		parts := markdownLink.FindStringSubmatch(whole)
		if externalLink.MatchString(parts[2]) {
			return parts[1]
		}
		return whole
	})
	text = angleURL.ReplaceAllString(text, "")
	// a bare address not right after a letter, a digit, "_" or "(" (JavaScript's lookbehind, which Go's regexp does not have)
	var out strings.Builder
	last := 0
	for _, at := range bareURL.FindAllStringIndex(text, -1) {
		if at[0] > 0 && (wordByte(text[at[0]-1]) || text[at[0]-1] == '(') {
			continue
		}
		out.WriteString(text[last:at[0]])
		last = at[1]
	}
	out.WriteString(text[last:])
	text = manySpaces.ReplaceAllString(out.String(), " ")
	return spaceBefore.ReplaceAllString(text, "$1")
}

// StripExternalLinks takes the outside addresses out of the text, never out of code (links.ts).
func StripExternalLinks(markdown string) string {
	var out strings.Builder
	last := 0
	for _, at := range fenced.FindAllStringIndex(markdown, -1) {
		out.WriteString(cleanLinks(markdown[last:at[0]]))
		out.WriteString(markdown[at[0]:at[1]])
		last = at[1]
	}
	out.WriteString(cleanLinks(markdown[last:]))
	return out.String()
}

// TableFallback is the table that stands for a diagram that did not come.
func TableFallback(hint string) string {
	best := []string{hint}
	for _, separator := range []string{". ", ", ", ";"} {
		cleaned := []string{}
		for _, part := range strings.Split(hint, separator) {
			if part = strings.TrimSpace(part); part != "" {
				cleaned = append(cleaned, part)
			}
		}
		if len(cleaned) > len(best) {
			best = cleaned
		}
	}
	lines := []string{"| Conceito | Descrição |", "|----------|-----------|"}
	for _, clause := range best {
		fields := strings.Fields(clause)
		concept, description := "", ""
		if len(fields) > 0 {
			concept = fields[0]
			description = strings.Join(fields[1:], " ")
		}
		lines = append(lines, "| "+concept+" | "+description+" |")
	}
	return strings.Join(lines, "\n")
}

var textTypes = map[string]bool{"paragraph": true, "heading": true, "bulletedList": true, "orderedList": true}

func elementText(element Element) string {
	kind := jsText(element["type"])
	if !textTypes[kind] {
		return ""
	}
	if kind == "bulletedList" || kind == "orderedList" {
		items := []string{}
		for _, item := range anyList(element["items"]) {
			items = append(items, jsText(item))
		}
		return strings.Join(items, "\n")
	}
	return jsText(element["text"])
}

func buildContext(elements []Element, at int) string {
	before, after := []string{}, []string{}
	for index := at - 1; index >= 0 && len(before) < 3; index-- {
		if value := elementText(elements[index]); value != "" {
			before = append([]string{value}, before...)
		}
	}
	for index := at + 1; index < len(elements) && len(after) < 3; index++ {
		if value := elementText(elements[index]); value != "" {
			after = append(after, value)
		}
	}
	return strings.Join(append(before, after...), "\n\n")
}

func diagramPrompt(kind, hint, context, previousError string) string {
	parts := []string{}
	if previousError != "" {
		parts = append(parts, "[Auto-Correção]\nErro na tentativa anterior: "+previousError+"\n")
	}
	parts = append(parts, prompts.Entry("DIAGRAM_SCHEMAS", kind), "\nO diagrama deve mostrar: "+hint+"\n", "Contexto do conteúdo:\n"+context+"\n", "Retorne apenas o objeto JSON de dados, sem cercas de markdown e sem campos extras.")
	return strings.Join(parts, "\n")
}

func resolveDiagram(ctx context.Context, chat Chat, elements []Element, slots []DiagramSlot, slot int) (string, error) {
	at := -1
	for index, element := range elements {
		if element["type"] == "diagram" {
			if number, ok := integer(element["diagramIndex"]); ok && number == slot {
				at = index
				break
			}
		}
	}
	context := buildContext(elements, at)
	previous := ""
	for attempt := 0; attempt < phaseTwoTries; attempt++ {
		raw, err := chat(ctx, diagramPrompt(slots[slot].Type, slots[slot].Hint, context, previous), prompts.Text("DIAGRAM_PROMPT"), 0)
		if err != nil {
			if cancelled(ctx, err) {
				return "", err
			}
			previous = err.Error()
			continue
		}
		data := ExtractJSON(raw)
		if data == nil {
			previous = "resposta sem JSON válido para o diagrama " + slots[slot].Type
			continue
		}
		code, err := Diagram(slots[slot].Type, data)
		if err == nil {
			return code, nil
		}
		previous = err.Error()
	}
	return TableFallback(slots[slot].Hint), nil
}

// Content writes a lesson (generateContent): the elements, checked, then the diagrams. The error after 5 tries says the last reason.
func Content(ctx context.Context, chat Chat, content, system string) (string, error) {
	var elements []Element
	var slots []DiagramSlot
	last := ""
	for attempt := 0; attempt < phaseOneTries && elements == nil; attempt++ {
		prompt := system
		if last != "" {
			prompt = "[Auto-Correção]\nErro na tentativa anterior: " + last + "\n--- PROMPT ORIGINAL (não modificar) ---\n" + system
		}
		raw, err := chat(ctx, content, prompt, 0)
		if err != nil {
			return "", err
		}
		payload := ExtractJSON(raw)
		if payload == nil {
			last = "resposta da IA não contém JSON válido"
			continue
		}
		found, diagrams, err := ValidateLesson(payload)
		if err != nil {
			last = err.Error()
			continue
		}
		elements, slots = found, diagrams
	}
	if elements == nil {
		return "", fmt.Errorf("Geração falhou após %d tentativas: %s", phaseOneTries, last)
	}
	resolved := make([]string, len(slots))
	errs := make([]error, len(slots))
	var wg sync.WaitGroup
	for slot := range slots {
		wg.Add(1)
		go func(slot int) {
			defer wg.Done()
			resolved[slot], errs[slot] = resolveDiagram(ctx, chat, elements, slots, slot)
		}(slot)
	}
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			return "", err
		}
	}
	return BuildMarkdown(elements, resolved, false), nil
}
