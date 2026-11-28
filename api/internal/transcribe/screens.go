package transcribe

import (
	"context"
	"errors"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"unicode"

	"github.com/regyeduardo/study-helper/api/internal/prompts"
)

// T205 (dono, 28/11: "Tudo em 1 min"; research R30): the screen read in Go from what the recording marked, as
// src/lib/generation/frames.ts does with the marks (marked-screens.ts): the frame of a moment is the photo of the screen marked last
// before it, the vision model looks at the screens where the speech points, a voice is named by its lit tile, and the terms come from the
// text the browser's OCR read while recording. No video is decoded.

// OcrText is a piece of text the OCR read, with how sure it is.
type OcrText struct {
	Text       string  `json:"text"`
	Confidence float64 `json:"confidence"`
}

// MarkedScreen is a screen of the recording's index (`screenIndex.screens`).
type MarkedScreen struct {
	At    float64   `json:"at"`
	End   float64   `json:"end"`
	Texts []OcrText `json:"texts,omitempty"`
}

// MarkedScreens are the screens the recording marked and the photo of each (the part `telas/<n>`).
type MarkedScreens struct {
	Screens []MarkedScreen
	Photo   func(ctx context.Context, n int) (string, error)
}

// Shot is the screen at a moment: its photo (a JPEG data URL), its signature (gray, to tell screens apart) and what an OCR read on it.
type Shot struct {
	Image     string
	Signature []float64
	Texts     []OcrText
}

// Screens gives the screen at each moment: from the marks of the recording, or from the frames of a video. The error says why none came.
type Screens interface {
	Shots(ctx context.Context, times []float64) (map[float64]Shot, error)
}

// Shots: the photo of the screen marked last before each moment, fetched once per screen.
func (m MarkedScreens) Shots(ctx context.Context, times []float64) (map[float64]Shot, error) {
	if len(m.Screens) == 0 {
		return nil, errors.New("a gravação não marcou nenhuma tela")
	}
	photos := map[int]string{}
	out := map[float64]Shot{}
	var last error
	for _, at := range times {
		n := m.at(at)
		image, ok := photos[n]
		if !ok {
			var err error
			if image, err = m.Photo(ctx, n); err != nil {
				last, image = err, ""
			}
			photos[n] = image
		}
		if image != "" {
			out[at] = Shot{Image: image, Signature: signatureOf(n), Texts: m.Screens[n].Texts}
		}
	}
	if len(out) == 0 && last != nil {
		return nil, last
	}
	return out, nil
}

// See asks the vision model about photos (data URLs).
type See func(ctx context.Context, images []string, prompt string) (string, error)

const (
	sameScreen    = 8
	seeAtOnce     = 4
	sure          = 0.9
	chunkOverlap  = 800
	noVisionWarn  = "A tela gravada não foi usada: escolha um modelo de Leitura de tela (ou de Vídeo e áudio) em Configurações › Inteligência artificial › Padrões por uso para o agente ler os nomes e os slides."
	ocrOnlyWarn   = "A tela gravada foi lida só pelo texto (OCR local): escolha um modelo de Leitura de tela (ou de Vídeo e áudio) em Configurações › Inteligência artificial › Padrões por uso para o agente entender os slides."
	visionTokens  = 1024
	readFailedFmt = "Não deu para ler a tela gravada (%s); a nota foi feita só com o som."
)

var lookAfter = []float64{0, 2, 5}

// ScreenUnread is the screen the person chose that could not be read: the work fails saying why (T188).
type ScreenUnread struct{ Reason string }

func (e *ScreenUnread) Error() string { return "A tela não foi lida: " + e.Reason }

func (m MarkedScreens) at(at float64) int {
	found := 0
	for n, screen := range m.Screens {
		if screen.At <= at {
			found = n
		}
	}
	return found
}

func signatureOf(n int) []float64 {
	out := make([]float64, 144)
	for i := range out {
		out[i] = float64((n>>(i%16))&1) * 255
	}
	return out
}

func signatureDistance(a, b []float64) float64 {
	length := min(len(a), len(b))
	if length == 0 {
		return math.Inf(1)
	}
	total := 0.0
	for i := 0; i < length; i++ {
		total += math.Abs(a[i] - b[i])
	}
	return total / float64(length)
}

type grabbed struct {
	at        float64
	image     string
	texts     []OcrText
	signature []float64
}

func distinctFrames(frames []grabbed) []grabbed {
	kept := []grabbed{}
	for _, frame := range frames {
		same := false
		for _, other := range kept {
			if signatureDistance(other.signature, frame.signature) < sameScreen {
				same = true
				break
			}
		}
		if !same {
			kept = append(kept, frame)
		}
	}
	return kept
}

type moment struct {
	at      float64
	kind    string // "tela" or "falante"
	from    float64
	speaker string
}

func screenMoments(rec Recording, asked []float64) []moment {
	end := 0.0
	for _, b := range rec.Blocks {
		end = math.Max(end, b.End)
	}
	out := []moment{}
	for _, start := range asked {
		for _, after := range lookAfter {
			out = append(out, moment{at: math.Min(start+after, end), kind: "tela", from: start})
		}
	}
	recorderKnown := false
	for _, s := range rec.Speakers {
		if s.ID == microphoneSpeaker && s.Name != recorderName {
			recorderKnown = true
		}
	}
	seen := map[string]bool{}
	for _, b := range rec.Blocks {
		if b.Speaker == "" || (b.Speaker == microphoneSpeaker && recorderKnown) || seen[b.Speaker] {
			continue
		}
		seen[b.Speaker] = true
		out = append(out, moment{at: b.Start + math.Min(1, (b.End-b.Start)/2), kind: "falante", speaker: b.Speaker})
	}
	return out
}

func transcriptChunks(transcript string) []string {
	if len(transcript) <= chunkChars {
		return []string{transcript}
	}
	pieces := []string{}
	for start := 0; start < len(transcript); {
		end := min(start+chunkChars, len(transcript))
		pieces = append(pieces, strings.ToValidUTF8(transcript[start:end], ""))
		if end == len(transcript) {
			break
		}
		start = end - chunkOverlap
	}
	return pieces
}

func clockSeconds(clock string) (float64, bool) {
	total := 0.0
	for _, part := range strings.Split(strings.TrimSpace(clock), ":") {
		value, err := strconv.ParseFloat(part, 64)
		if err != nil {
			return 0, false
		}
		total = total*60 + value
	}
	return total, true
}

// askedMoments: the starts of the speeches that need the screen (names, siglas, "olha essa tela"), as the AI finds them.
func askedMoments(ctx context.Context, rec Recording, chat Chat) ([]float64, error) {
	if chat == nil {
		return nil, nil
	}
	pieces := transcriptChunks(TranscriptText(rec.Blocks, rec.Speakers))
	answers := make([]string, len(pieces))
	errs := make([]error, len(pieces))
	var wg sync.WaitGroup
	for i, piece := range pieces {
		wg.Add(1)
		go func(i int, piece string) {
			defer wg.Done()
			answers[i], errs[i] = chat(ctx, piece, prompts.Text("SCREEN_ASKS_PROMPT"))
		}(i, piece)
	}
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			return nil, err
		}
	}
	found := map[float64]bool{}
	for _, answer := range answers {
		hours, _ := ExtractJSON(answer)["horas"].([]any)
		for _, hour := range hours {
			text, _ := hour.(string)
			at, ok := clockSeconds(text)
			if !ok {
				continue
			}
			best := at
			for i, b := range rec.Blocks {
				if i == 0 || math.Abs(b.Start-at) < math.Abs(best-at) {
					best = b.Start
				}
			}
			found[best] = true
		}
	}
	out := []float64{}
	for at := range found {
		out = append(out, at)
	}
	sort.Float64s(out)
	return out, nil
}

func field(answer, name string) string {
	value, _ := ExtractJSON(answer)[name].(string)
	return strings.TrimSpace(value)
}

// LookAtScreen reads the screen of the recording from its marks. `see` nil: no vision model (the terms only). `strict`: the person
// chose the screen, so what keeps it from being read is an error (*ScreenUnread), never a transcription that goes on without it.
func LookAtScreen(ctx context.Context, rec Recording, screens Screens, chat Chat, see See, strict bool) (Recording, error) {
	unread := func(reason string) (Recording, error) {
		if strict {
			return rec, &ScreenUnread{Reason: reason}
		}
		rec.Warning = strings.TrimSpace(rec.Warning + " " + fmt.Sprintf(readFailedFmt, reason))
		return rec, nil
	}
	asked, err := askedMoments(ctx, rec, chat)
	if err != nil {
		if ctx.Err() != nil {
			return rec, ctx.Err()
		}
		return unread(err.Error())
	}
	moments := screenMoments(rec, asked)
	times := map[float64]bool{}
	for _, m := range moments {
		times[m.at] = true
	}
	ordered := []float64{}
	for at := range times {
		ordered = append(ordered, at)
	}
	sort.Float64s(ordered)
	taken, err := screens.Shots(ctx, ordered)
	if err != nil {
		if ctx.Err() != nil {
			return rec, ctx.Err()
		}
		return unread(err.Error())
	}
	shots := map[float64]grabbed{}
	for at, shot := range taken {
		shots[at] = grabbed{at: at, image: shot.Image, texts: shot.Texts, signature: shot.Signature}
	}
	frames := make([]grabbed, 0, len(shots))
	for _, at := range ordered {
		if shot, ok := shots[at]; ok {
			frames = append(frames, shot)
		}
	}
	// the terms: what the OCR read on the screens looked at, while recording
	reading := [][]OcrText{}
	for _, frame := range distinctFrames(frames) {
		reading = append(reading, frame.texts)
	}
	if see == nil {
		terms := voteTerms(reading).Exact
		warning := noVisionWarn
		if len(terms) > 0 {
			warning = ocrOnlyWarn
			rec.ScreenTerms = terms
		}
		rec.Warning = strings.TrimSpace(rec.Warning + " " + warning)
		return rec, nil
	}
	type look struct {
		at    float64
		shots []grabbed
	}
	looks := []look{}
	read := []grabbed{}
	starts := []float64{}
	seenStart := map[float64]bool{}
	for _, m := range moments {
		if m.kind == "tela" && !seenStart[m.from] {
			seenStart[m.from] = true
			starts = append(starts, m.from)
		}
	}
	for _, start := range starts {
		candidates := []grabbed{}
		for _, m := range moments {
			if m.kind == "tela" && m.from == start {
				if shot, ok := shots[m.at]; ok {
					candidates = append(candidates, shot)
				}
			}
		}
		fresh := []grabbed{}
		for _, shot := range distinctFrames(candidates) {
			repeated := false
			for _, other := range read {
				if signatureDistance(other.signature, shot.signature) < sameScreen {
					repeated = true
				}
			}
			if !repeated {
				fresh = append(fresh, shot)
			}
		}
		if len(fresh) == 0 {
			continue
		}
		read = append(read, fresh...)
		looks = append(looks, look{at: start, shots: fresh})
	}
	type face struct {
		shot  grabbed
		index int
	}
	speakers := append([]Speaker(nil), rec.Speakers...)
	faces := []face{}
	for _, m := range moments {
		if m.kind != "falante" {
			continue
		}
		shot, ok := shots[m.at]
		if !ok {
			continue
		}
		for i, s := range speakers {
			if s.ID == m.speaker {
				faces = append(faces, face{shot, i})
			}
		}
	}
	type ask struct {
		images []string
		prompt string
	}
	asks := []ask{}
	for _, l := range looks {
		images := []string{}
		for _, s := range l.shots {
			images = append(images, s.image)
		}
		asks = append(asks, ask{images, prompts.Text("SCREEN_TEXT_PROMPT")})
	}
	for _, f := range faces {
		asks = append(asks, ask{[]string{f.shot.image}, strings.ReplaceAll(prompts.Text("SCREEN_NAME_PROMPT"), "{nome}", speakers[f.index].Name)})
	}
	answers := make([]string, len(asks))
	failures := []error{}
	var mu sync.Mutex
	slots := make(chan struct{}, seeAtOnce)
	var wg sync.WaitGroup
	for i, a := range asks {
		wg.Add(1)
		go func(i int, a ask) {
			defer wg.Done()
			slots <- struct{}{}
			defer func() { <-slots }()
			answer, err := see(ctx, a.images, a.prompt)
			if err != nil {
				mu.Lock()
				failures = append(failures, err)
				mu.Unlock()
				return
			}
			answers[i] = answer
		}(i, a)
	}
	wg.Wait()
	if ctx.Err() != nil {
		return rec, ctx.Err()
	}
	if len(asks) > 0 && len(failures) == len(asks) {
		return unread(failures[0].Error())
	}
	found := []Frame{}
	for i, l := range looks {
		if text := field(answers[i], "texto"); text != "" {
			found = append(found, Frame{At: l.at, Image: l.shots[len(l.shots)-1].image, Text: text})
		}
	}
	for i, f := range faces {
		if name := field(answers[len(looks)+i], "nome"); name != "" {
			speakers[f.index] = Speaker{ID: speakers[f.index].ID, Name: name}
		}
	}
	sort.Slice(found, func(i, j int) bool { return found[i].At < found[j].At })
	rec.Speakers = distinctNames(rec.Speakers, speakers)
	if len(found) > 0 {
		rec.Frames = found
	}
	if terms := voteTerms(reading).Exact; len(terms) > 0 {
		rec.ScreenTerms = terms
	}
	if len(failures) > 0 {
		rec.Warning = strings.TrimSpace(rec.Warning + " " + fmt.Sprintf("%d de %d olhadas da tela não vieram (%s).", len(failures), len(asks), failures[0].Error()))
	}
	return rec, nil
}

// --- the terms of the screen (screen-terms.ts) ---

var (
	tokenSplit = regexp.MustCompile(`[\s()\[\]{};:"'<>=$|*+!?]+`)
	tokenEdges = regexp.MustCompile(`^[.,\-/]+|[.,\-/]+$`)
	numberRe   = regexp.MustCompile(`^[\d.,%]+$`)
	addressRe  = regexp.MustCompile(`^[\p{L}\d-]+(\.[\p{L}\d-]+)+$`)
	capitalRe  = regexp.MustCompile(`^\p{Lu}\p{Ll}{2,}`)
	connectors = map[string]bool{"de": true, "da": true, "do": true, "dos": true, "das": true, "e": true, "a": true}
)

func isNumber(token string) bool {
	if !numberRe.MatchString(token) || !hasDigit(token) {
		return false
	}
	if strings.ContainsAny(token, ".,%") {
		digits := 0
		for _, r := range token {
			if unicode.IsDigit(r) {
				digits++
			}
		}
		return digits >= 2
	}
	return len(token) >= 4
}

func hasLetter(text string) bool { return strings.IndexFunc(text, unicode.IsLetter) >= 0 }

func isCode(token string) bool {
	return len([]rune(token)) >= 3 && hasLetter(token) && hasDigit(token)
}

func termsIn(text string) []string {
	out := []string{}
	phrase := []string{}
	flush := func() {
		for len(phrase) > 0 && connectors[phrase[len(phrase)-1]] {
			phrase = phrase[:len(phrase)-1]
		}
		if len(phrase) > 1 || (len(phrase) == 1 && (len([]rune(phrase[0])) >= 4 || isAcronym(phrase[0]))) {
			out = append(out, strings.Join(phrase, " "))
		}
		phrase = nil
	}
	for _, raw := range tokenSplit.Split(text, -1) {
		token := tokenEdges.ReplaceAllString(raw, "")
		if token == "" {
			continue
		}
		switch {
		case !hasDigit(token) && (capitalRe.MatchString(token) || isAcronym(token)):
			phrase = append(phrase, token)
		case len(phrase) > 0 && connectors[token]:
			phrase = append(phrase, token)
		default:
			flush()
			if isNumber(token) || isCode(token) || (addressRe.MatchString(token) && hasLetter(token)) {
				out = append(out, token)
			}
		}
	}
	flush()
	return out
}

func levenshtein(a, b string) int {
	ra, rb := []rune(a), []rune(b)
	row := make([]int, len(rb)+1)
	for j := range row {
		row[j] = j
	}
	for i := 1; i <= len(ra); i++ {
		next := make([]int, len(rb)+1)
		next[0] = i
		for j := 1; j <= len(rb); j++ {
			cost := 1
			if ra[i-1] == rb[j-1] {
				cost = 0
			}
			next[j] = min(row[j]+1, next[j-1]+1, row[j-1]+cost)
		}
		row = next
	}
	return row[len(rb)]
}

func sameTerm(a, b string) bool {
	if a == b {
		return true
	}
	la, lb := len([]rune(a)), len([]rune(b))
	return !hasDigit(a) && !hasDigit(b) && min(la, lb) >= 6 && levenshtein(a, b) <= max(1, max(la, lb)/8)
}

// ScreenTerms are the terms read with certainty (exact) and the ones never read so (hints only).
type ScreenTerms struct {
	Exact    []string
	Doubtful []string
}

// voteTerms: one vote per screen; the sure readings decide; a term never read with certainty stays a hint (screen-terms.ts).
func voteTerms(screens [][]OcrText) ScreenTerms {
	type vote struct {
		term         string
		sure, seen   int
		weight, best float64
		order        int
	}
	type group struct {
		key   string
		first int
		votes []*vote
	}
	groups := []*group{}
	order := 0
	for _, texts := range screens {
		best := map[string]float64{}
		terms := []string{}
		for _, item := range texts {
			for _, term := range termsIn(item.Text) {
				if _, ok := best[term]; !ok {
					terms = append(terms, term)
				}
				best[term] = math.Max(best[term], item.Confidence)
			}
		}
		for _, term := range terms {
			confidence := best[term]
			key := flat(term)
			if key == "" {
				continue
			}
			var g *group
			for _, candidate := range groups {
				if sameTerm(candidate.key, key) {
					g = candidate
					break
				}
			}
			if g == nil {
				g = &group{key: key, first: order}
				order++
				groups = append(groups, g)
			}
			var v *vote
			for _, existing := range g.votes {
				if existing.term == term {
					v = existing
				}
			}
			if v == nil {
				v = &vote{term: term, order: len(g.votes)}
				g.votes = append(g.votes, v)
			}
			if confidence >= sure {
				v.sure++
				v.weight += confidence
			}
			v.seen++
			v.best = math.Max(v.best, confidence)
		}
	}
	type winner struct {
		group *group
		top   *vote
	}
	winners := []winner{}
	for _, g := range groups {
		ranked := append([]*vote(nil), g.votes...)
		sort.SliceStable(ranked, func(i, j int) bool {
			a, b := ranked[i], ranked[j]
			if a.sure != b.sure {
				return a.sure > b.sure
			}
			if a.weight != b.weight {
				return a.weight > b.weight
			}
			if a.seen != b.seen {
				return a.seen > b.seen
			}
			return a.best > b.best
		})
		winners = append(winners, winner{g, ranked[0]})
	}
	exact := []winner{}
	out := ScreenTerms{}
	for _, w := range winners {
		if w.top.sure > 0 {
			exact = append(exact, w)
		} else {
			out.Doubtful = append(out.Doubtful, w.top.term)
		}
	}
	sort.SliceStable(exact, func(i, j int) bool {
		a, b := exact[i], exact[j]
		na, nb := isNumber(a.top.term), isNumber(b.top.term)
		if na != nb {
			return !na
		}
		if a.top.sure != b.top.sure {
			return a.top.sure > b.top.sure
		}
		return a.group.first < b.group.first
	})
	for _, w := range exact {
		out.Exact = append(out.Exact, w.top.term)
	}
	return out
}

// distinctNames: no two voices end with the same name (turns.ts, FR-059).
func distinctNames(before, after []Speaker) []Speaker {
	key := func(name string) string {
		return flat(strings.TrimSpace(name)) + "|" + strings.ToLower(strings.TrimSpace(name))
	}
	holders := func(speakers []Speaker) map[string][]string {
		out := map[string][]string{}
		for _, s := range speakers {
			k := key(s.Name)
			out[k] = append(out[k], s.ID)
		}
		return out
	}
	previous := map[string]Speaker{}
	for _, s := range before {
		previous[s.ID] = s
	}
	settled := func(s Speaker) bool {
		old, ok := previous[s.ID]
		return s.ID == microphoneSpeaker && s.Name != recorderName && ok && old.Name == s.Name
	}
	byID := func(list []Speaker, id string) Speaker {
		for _, s := range list {
			if s.ID == id {
				return s
			}
		}
		return Speaker{}
	}
	first := holders(after)
	kept := make([]Speaker, len(after))
	for i, s := range after {
		same := first[key(s.Name)]
		if len(same) < 2 {
			kept[i] = s
			continue
		}
		owner := ""
		for _, id := range same {
			if settled(byID(after, id)) {
				owner = id
				break
			}
		}
		if owner == "" {
			had := []string{}
			for _, id := range same {
				if old, ok := previous[id]; ok && key(old.Name) == key(s.Name) {
					had = append(had, id)
				}
			}
			if len(had) == 1 {
				owner = had[0]
			}
		}
		if owner == s.ID {
			kept[i] = s
		} else if old, ok := previous[s.ID]; ok {
			kept[i] = old
		} else {
			kept[i] = s
		}
	}
	second := holders(kept)
	repeated := false
	for _, ids := range second {
		if len(ids) > 1 {
			repeated = true
		}
	}
	if !repeated {
		return kept
	}
	used := map[string]bool{}
	for _, s := range kept {
		used[key(s.Name)] = true
	}
	free := func() string {
		for number := 1; ; number++ {
			name := fmt.Sprintf("Falante %d", number)
			if !used[key(name)] {
				used[key(name)] = true
				return name
			}
		}
	}
	out := make([]Speaker, len(kept))
	for i, s := range kept {
		if len(second[key(s.Name)]) < 2 || settled(s) {
			out[i] = s
			continue
		}
		out[i] = Speaker{ID: s.ID, Name: free()}
	}
	return out
}
