package transcribe

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"unicode"

	"github.com/regyeduardo/study-helper/api/internal/prompts"
)

// Frame is what the vision model read on the screen at a moment (`recording.frames`).
type Frame struct {
	At    float64 `json:"at"`
	Image string  `json:"image"`
	Text  string  `json:"text"`
}

// Recording is the transcription as the note keeps it (`recording` in the part `transcript`).
type Recording struct {
	Blocks      []Block         `json:"blocks"`
	Speakers    []Speaker       `json:"speakers"`
	Marks       json.RawMessage `json:"marks,omitempty"`
	Warning     string          `json:"warning,omitempty"`
	Frames      []Frame         `json:"frames,omitempty"`
	ScreenTerms []string        `json:"screenTerms,omitempty"`
	ScreenIndex json.RawMessage `json:"screenIndex,omitempty"`
	Heard       json.RawMessage `json:"heard,omitempty"`
}

// Chat asks the AI once (the "Título" model of the account): what the person sees, and the instruction.
type Chat func(ctx context.Context, user, system string) (string, error)

const (
	chunkChars      = 12000
	pieceChars      = 4000
	titleMax        = 80
	heardWordsMax   = 6
	addedWordsMax   = 2
	maxScreenTerms  = 150
	instructionHead = "## Instrução de quem pediu (siga com prioridade, sem inventar nada)"
)

var unnamed = regexp.MustCompile(`^Falante \d+$`)

// TermsHint is the person's terms as a line ("Termos que aparecem nesta gravação: a, b.").
func TermsHint(terms string) string {
	list := []string{}
	for _, term := range strings.FieldsFunc(terms, func(r rune) bool { return r == '\n' || r == ',' || r == ';' }) {
		if term = strings.TrimSpace(term); term != "" {
			list = append(list, term)
		}
	}
	if len(list) == 0 {
		return ""
	}
	return "Termos que aparecem nesta gravação: " + strings.Join(list, ", ") + "."
}

func split(lines []string, limit int) [][]string {
	out := [][]string{{}}
	size := 0
	for _, line := range lines {
		if size+len(line) > limit && len(out[len(out)-1]) > 0 {
			out = append(out, []string{})
			size = 0
		}
		out[len(out)-1] = append(out[len(out)-1], line)
		size += len(line)
	}
	return out
}

// ExtractJSON is the first JSON object in an answer (fences and text around it are ignored), as `extractJson` in mermaid.ts.
func ExtractJSON(raw string) map[string]any {
	stripped := strings.TrimSpace(raw)
	if strings.HasPrefix(stripped, "```") {
		stripped = regexp.MustCompile("^```[a-zA-Z]*\\n?").ReplaceAllString(stripped, "")
		stripped = strings.TrimSpace(strings.TrimSuffix(stripped, "```"))
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

var (
	titleEdges = regexp.MustCompile(`^["“”'\s]+|["“”'.\s]+$`)
	lastWord   = regexp.MustCompile(`\s+\S*$`)
	wordsRe    = regexp.MustCompile(`[\p{L}\p{N}]+`)
)

// CleanTitle is a title without quotes around and at most 80 characters, cut on a word (title.ts).
func CleanTitle(raw any) string {
	text, _ := raw.(string)
	title := titleEdges.ReplaceAllString(text, "")
	if runes := []rune(title); len(runes) > titleMax {
		title = lastWord.ReplaceAllString(string(runes[:titleMax]), "")
	}
	return title
}

type suggestion struct{ speaker, name string }
type correction struct {
	speech       int
	heard, meant string
}

func listOf(answer map[string]any, key string) []map[string]any {
	list, _ := answer[key].([]any)
	out := []map[string]any{}
	for _, item := range list {
		if row, ok := item.(map[string]any); ok {
			out = append(out, row)
		}
	}
	return out
}

func trimmed(value any) string {
	text, _ := value.(string)
	return strings.TrimSpace(text)
}

func suggestionsIn(answer map[string]any) []suggestion {
	out := []suggestion{}
	for _, row := range listOf(answer, "nomes") {
		out = append(out, suggestion{trimmed(row["falante"]), trimmed(row["nome"])})
	}
	return out
}

func correctionsIn(answer map[string]any) []correction {
	out := []correction{}
	for _, row := range listOf(answer, "correcoes") {
		speech, _ := number(row["fala"])
		heard, _ := row["de"].(string)
		meant, _ := row["para"].(string)
		out = append(out, correction{int(speech), heard, meant})
	}
	return out
}

func wordsOf(text string) []string { return wordsRe.FindAllString(strings.ToLower(text), -1) }

func onlyRemoves(heard, meant []string) bool {
	at := 0
	for _, w := range heard {
		if at < len(meant) && w == meant[at] {
			at++
		}
	}
	return at == len(meant) && len(meant) < len(heard)
}

func accepted(c correction, block *Block) bool {
	if block == nil || c.heard == "" || strings.TrimSpace(c.meant) == "" || !strings.Contains(block.Text, c.heard) {
		return false
	}
	heard, meant := wordsOf(c.heard), wordsOf(c.meant)
	return len(heard) <= heardWordsMax && len(meant) <= len(heard)+addedWordsMax && !onlyRemoves(heard, meant)
}

func withCorrections(rec Recording, corrections []correction) Recording {
	blocks := append([]Block(nil), rec.Blocks...)
	for _, c := range corrections {
		if c.speech < 1 || c.speech > len(blocks) {
			continue
		}
		block := &blocks[c.speech-1]
		if !accepted(c, block) {
			continue
		}
		if block.Original == "" {
			block.Original = block.Text
		}
		block.Text = strings.Replace(block.Text, c.heard, c.meant, 1)
	}
	rec.Blocks = blocks
	return rec
}

// applied gives a voice a name the AI found in the conversation, never a name another voice has, never over the name of who recorded.
func applied(speakers []Speaker, found []suggestion, transcript string) []Speaker {
	said := strings.ToLower(transcript)
	taken := map[string]bool{}
	for _, s := range speakers {
		taken[strings.ToLower(s.Name)] = true
	}
	out := append([]Speaker(nil), speakers...)
	for i, s := range out {
		if s.ID == microphoneSpeaker && s.Name != recorderName {
			continue
		}
		for _, item := range found {
			name := strings.ToLower(item.name)
			if item.speaker == s.Name && item.name != "" && strings.Contains(said, name) && !taken[name] {
				taken[name] = true
				out[i] = Speaker{ID: s.ID, Name: item.name, Suggested: true}
				break
			}
		}
	}
	return out
}

// Polish gives the transcription its title, the names of the voices and the corrections (polish.ts): small pieces asked at once, and a
// long transcription gets its title from its own call over the opening. When the AI fails, it stays as heard and says why.
func Polish(ctx context.Context, rec Recording, chat Chat, terms, instruction string) (Recording, string) {
	if len(rec.Blocks) == 0 {
		return rec, ""
	}
	context := ""
	if asked := strings.TrimSpace(instruction); asked != "" {
		context += instructionHead + "\n\n" + asked + "\n\n"
	}
	if hint := TermsHint(terms); hint != "" {
		context += hint + "\n\n"
	}
	if len(rec.Speakers) > 0 {
		names := make([]string, len(rec.Speakers))
		for i, s := range rec.Speakers {
			names[i] = s.Name
		}
		context += "Participantes: " + strings.Join(names, ", ") + "\n\n"
	}
	context += screenWriting(rec)
	nameOf := map[string]string{}
	for _, s := range rec.Speakers {
		nameOf[s.ID] = s.Name
	}
	lines := make([]string, len(rec.Blocks))
	for i, b := range rec.Blocks {
		who := ""
		if b.Speaker != "" {
			name, ok := nameOf[b.Speaker]
			if !ok {
				name = b.Speaker
			}
			who = name + " "
		}
		lines[i] = fmt.Sprintf("%d | %s[%s]: %s", i+1, who, clockTime(b.Start), b.Text)
	}
	pieces := split(lines, pieceChars)
	long := len(pieces) > 1
	answers := make([]string, len(pieces))
	opening := ""
	errs := make([]error, len(pieces)+1)
	var wg sync.WaitGroup
	if long {
		wg.Add(1)
		go func() {
			defer wg.Done()
			opening, errs[len(pieces)] = chat(ctx, context+strings.Join(split(lines, chunkChars)[0], "\n"), prompts.Text("TITLE_PROMPT"))
		}()
	}
	for i, piece := range pieces {
		wg.Add(1)
		go func(i int, piece []string) {
			defer wg.Done()
			ask := `Primeiro trecho: devolva também o "titulo".`
			if long {
				ask = `Trecho da gravação: não devolva "titulo".`
			}
			answers[i], errs[i] = chat(ctx, ask+"\n\n"+context+strings.Join(piece, "\n"), prompts.Text("POLISH_PROMPT"))
		}(i, piece)
	}
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			reason := "A revisão por IA não rodou (nomes e palavras ficaram como o áudio saiu): " + err.Error()
			if rec.Warning != "" {
				reason = rec.Warning + " " + reason
			}
			rec.Warning = reason
			return rec, ""
		}
	}
	names, corrections := []suggestion{}, []correction{}
	for _, answer := range answers {
		parsed := ExtractJSON(answer)
		for _, s := range suggestionsIn(parsed) {
			if unnamed.MatchString(s.speaker) || s.speaker == recorderName {
				names = append(names, s)
			}
		}
		corrections = append(corrections, correctionsIn(parsed)...)
	}
	source := answers[0]
	if long {
		source = opening
	}
	title := CleanTitle(ExtractJSON(source)["titulo"])
	rec.Speakers = applied(rec.Speakers, names, TranscriptText(rec.Blocks, rec.Speakers))
	return withCorrections(rec, corrections), title
}

// flat is a term without case, accents and anything that is not a letter or a number (screen-terms.ts).
func flat(text string) string {
	lower := accents.Replace(strings.ToLower(text))
	var out strings.Builder
	for _, r := range lower {
		if unicode.IsLetter(r) || unicode.IsNumber(r) {
			out.WriteRune(r)
		}
	}
	return out.String()
}

func hasDigit(text string) bool { return strings.IndexFunc(text, unicode.IsNumber) >= 0 }

var acronymRe = regexp.MustCompile(`^[\p{Lu}\d][\p{Lu}\d\-_.&/]*$`)

func isAcronym(token string) bool {
	if len([]rune(token)) < 3 || !acronymRe.MatchString(token) {
		return false
	}
	upper := 0
	for _, r := range token {
		if unicode.IsUpper(r) {
			upper++
		}
	}
	return upper >= 2
}

var sounds = []string{"bcdegptvz", "flmnrs"}

func soundAlike(a, b string) bool {
	differ := 0
	for i := 0; i < len(a) && i < len(b); i++ {
		if a[i] == b[i] {
			continue
		}
		alike := false
		for _, letters := range sounds {
			if strings.IndexByte(letters, a[i]) >= 0 && strings.IndexByte(letters, b[i]) >= 0 {
				alike = true
			}
		}
		if !alike {
			return false
		}
		differ++
	}
	return differ == 1
}

type pair struct{ heard, term string }

func trimWord(word string) string {
	runes := []rune(word)
	start, end := 0, len(runes)
	for start < end && !unicode.IsLetter(runes[start]) && !unicode.IsNumber(runes[start]) {
		start++
	}
	for end > start && !unicode.IsLetter(runes[end-1]) && !unicode.IsNumber(runes[end-1]) && runes[end-1] != '%' {
		end--
	}
	return string(runes[start:end])
}

// sentences splits after a sentence ends (".", "!", "?", "…" and a space) and on line breaks.
func sentences(text string) []string {
	out := []string{}
	for _, line := range strings.Split(text, "\n") {
		start := 0
		runes := []rune(line)
		for i := 0; i < len(runes); i++ {
			if strings.ContainsRune(".!?…", runes[i]) && i+1 < len(runes) && unicode.IsSpace(runes[i+1]) {
				out = append(out, string(runes[start:i+1]))
				start = i + 1
			}
		}
		out = append(out, string(runes[start:]))
	}
	return out
}

func startsNamed(word string) bool {
	r := []rune(word)
	return len(r) > 0 && (unicode.IsUpper(r[0]) || unicode.IsDigit(r[0]))
}

func allUpperOrDigits(word string) bool {
	for _, r := range word {
		if !unicode.IsUpper(r) && !unicode.IsDigit(r) {
			return false
		}
	}
	return word != ""
}

func allUpper(word string) bool {
	for _, r := range word {
		if !unicode.IsUpper(r) {
			return false
		}
	}
	return word != ""
}

// closePairs: where the speech and an exact screen term agree closely (screen-terms.ts).
func closePairs(speech string, exact []string) []pair {
	type token struct {
		word, key    string
		named, opens bool
	}
	words := []token{}
	for _, sentence := range sentences(speech) {
		index := 0
		for _, raw := range strings.Fields(sentence) {
			word := trimWord(raw)
			if word == "" {
				continue
			}
			words = append(words, token{word, flat(word), startsNamed(word), index == 0})
			index++
		}
	}
	type term struct {
		term, key string
		size      int
		acronym   bool
	}
	byKey := map[string][]term{}
	acronyms := []term{}
	for _, t := range exact {
		item := term{t, flat(t), len(strings.Fields(t)), isAcronym(t) && !hasDigit(t)}
		byKey[item.key] = append(byKey[item.key], item)
		if item.acronym {
			acronyms = append(acronyms, item)
		}
	}
	found := map[string]bool{}
	out := []pair{}
	for index := range words {
		if !words[index].named || (words[index].opens && !allUpperOrDigits(words[index].word)) {
			continue
		}
		key := ""
		for n := 1; n <= 5 && index+n <= len(words) && words[index+n-1].named; n++ {
			key += words[index+n-1].key
			parts := []string{}
			for _, w := range words[index : index+n] {
				parts = append(parts, w.word)
			}
			heard := strings.Join(parts, " ")
			exists := false
			for _, item := range byKey[key] {
				if item.term == heard {
					exists = true
				}
			}
			if len(key) < 2 || found[heard] || exists {
				continue
			}
			var match *term
			for i, item := range byKey[key] {
				if item.term != heard && abs(item.size-n) <= 1 {
					match = &byKey[key][i]
					break
				}
			}
			if match == nil && n == 1 && allUpper(heard) {
				for i, item := range acronyms {
					if len(item.key) == len(key) && soundAlike(key, item.key) {
						match = &acronyms[i]
						break
					}
				}
			}
			if match != nil {
				found[heard] = true
				out = append(out, pair{heard, match.term})
			}
		}
	}
	return out
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

// screenWriting is what was written on the screen, for the review (screen-terms.ts): the frames read and the exact terms, and the only
// corrections of the speech the screen allows.
func screenWriting(rec Recording) string {
	read := []string{}
	for _, f := range rec.Frames {
		read = append(read, f.Text)
	}
	terms := rec.ScreenTerms
	if len(terms) > maxScreenTerms {
		terms = terms[:maxScreenTerms]
	}
	if len(read) == 0 && len(terms) == 0 {
		return ""
	}
	if len(terms) > 0 {
		read = append(read, "lido com certeza: "+strings.Join(terms, ", "))
	}
	texts := make([]string, len(rec.Blocks))
	for i, b := range rec.Blocks {
		texts[i] = b.Text
	}
	out := "Escrito na tela durante a reunião: " + strings.Join(read, " | ") + "\n"
	if pairs := closePairs(strings.Join(texts, "\n"), rec.ScreenTerms); len(pairs) > 0 {
		listed := make([]string, len(pairs))
		for i, p := range pairs {
			listed[i] = p.heard + " → " + p.term
		}
		out += "Ouvido parecido com o escrito na tela (pela tela, só estes podem ser corrigidos): " + strings.Join(listed, "; ") + "\n"
	}
	return out + "\n"
}
