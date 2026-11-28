// Package transcribe makes the transcription of a recording in the server (T204, spec 007; dono, 28/11: "a prioridade máxima é o
// backend go"): the audio cut by ffmpeg without decoding, the parts heard at once (the times of each word by Whisper, the text by a model
// that hears), the voices split, and the transcription put together as the app does it in the browser (src/lib/transcription/align.ts
// and turns.ts), so both sides give the same transcription.
package transcribe

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
	"strings"
)

// Word is one word heard, with its times (seconds of the recording).
type Word struct {
	Start float64
	End   float64
	Text  string
}

// Turn is a stretch of one voice (the voice split).
type Turn struct {
	Start   float64
	End     float64
	Speaker string
}

// Block is a paragraph of one speaker, as the note keeps it (`recording.blocks`).
type Block struct {
	Speaker string  `json:"speaker"`
	Start   float64 `json:"start"`
	End     float64 `json:"end"`
	Text    string  `json:"text"`
	// Original is the text as heard, when the review corrected it.
	Original string `json:"original,omitempty"`
}

// Speaker is a voice of the note (`recording.speakers`).
type Speaker struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Suggested bool   `json:"suggested"`
}

const (
	sameScore      = 2
	alikeScore     = 1
	otherScore     = -1
	gapScore       = -1
	secondsPerWord = 0.35
	keptRun        = 5
	runPause       = 1.5

	moveDiagonal = 1
	moveUp       = 2
	moveLeft     = 3
)

var accents = strings.NewReplacer("á", "a", "à", "a", "â", "a", "ã", "a", "ä", "a", "å", "a", "é", "e", "è", "e", "ê", "e", "ë", "e", "í", "i", "ì", "i", "î", "i", "ï", "i",
	"ó", "o", "ò", "o", "ô", "o", "õ", "o", "ö", "o", "ú", "u", "ù", "u", "û", "u", "ü", "u", "ç", "c", "ñ", "n", "ý", "y", "ÿ", "y")

// WithoutAccents is the lowercase text without the accents of Portuguese (and the common ones of other languages).
func WithoutAccents(text string) string { return accents.Replace(strings.ToLower(text)) }

// plain is a word without case, accents and anything that is not a letter or a digit (as `plain` in align.ts).
func plain(text string) string {
	lower := accents.Replace(strings.ToLower(text))
	var out strings.Builder
	for _, r := range lower {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			out.WriteRune(r)
		}
	}
	return out.String()
}

func similarity(a, b string) float64 {
	if a == b {
		return 1
	}
	if a == "" || b == "" {
		return 0
	}
	previous := make([]int, len(b)+1)
	for j := range previous {
		previous[j] = j
	}
	for i := 1; i <= len(a); i++ {
		current := make([]int, len(b)+1)
		current[0] = i
		for j := 1; j <= len(b); j++ {
			cost := 1
			if a[i-1] == b[j-1] {
				cost = 0
			}
			current[j] = min(previous[j]+1, current[j-1]+1, previous[j-1]+cost)
		}
		previous = current
	}
	return 1 - float64(previous[len(b)])/float64(max(len(a), len(b)))
}

func score(a, b string) int {
	if a == b {
		return sameScore
	}
	if similarity(a, b) >= 0.5 {
		return alikeScore
	}
	return otherScore
}

func repeats(run []Word) bool {
	kinds := map[string]bool{}
	for _, w := range run {
		kinds[plain(w.Text)] = true
	}
	return len(kinds)*2 <= len(run)
}

// AlignWords puts the words of a text-only transcription (better words, no times) on the timeline of a timed one. Timed words nobody
// else heard are dropped, unless they are a long, varied stretch (align.ts).
func AlignWords(timed []Word, text string, from, to float64) []Word {
	said := []string{}
	for _, token := range strings.Fields(text) {
		if plain(token) != "" {
			said = append(said, token)
		}
	}
	if len(said) == 0 {
		return timed
	}
	a := make([]string, len(timed))
	for i, w := range timed {
		a[i] = plain(w.Text)
	}
	b := make([]string, len(said))
	for j, token := range said {
		b[j] = plain(token)
	}
	rows, columns := len(a)+1, len(b)+1
	best := make([]int32, rows*columns)
	step := make([]uint8, rows*columns)
	for i := 1; i < rows; i++ {
		best[i*columns] = int32(i * gapScore)
		step[i*columns] = moveUp
	}
	for j := 1; j < columns; j++ {
		best[j] = int32(j * gapScore)
		step[j] = moveLeft
	}
	for i := 1; i < rows; i++ {
		for j := 1; j < columns; j++ {
			diagonal := best[(i-1)*columns+j-1] + int32(score(a[i-1], b[j-1]))
			up := best[(i-1)*columns+j] + gapScore
			left := best[i*columns+j-1] + gapScore
			top := max(diagonal, up, left)
			best[i*columns+j] = top
			switch top {
			case diagonal:
				step[i*columns+j] = moveDiagonal
			case up:
				step[i*columns+j] = moveUp
			default:
				step[i*columns+j] = moveLeft
			}
		}
	}
	type pair struct{ i, j int } // -1: none
	pairs := []pair{}
	for i, j := len(a), len(b); i > 0 || j > 0; {
		switch step[i*columns+j] {
		case moveDiagonal:
			i, j = i-1, j-1
			pairs = append(pairs, pair{i, j})
		case moveUp:
			i--
			pairs = append(pairs, pair{i, -1})
		default:
			j--
			pairs = append(pairs, pair{-1, j})
		}
	}
	for left, right := 0, len(pairs)-1; left < right; left, right = left+1, right-1 {
		pairs[left], pairs[right] = pairs[right], pairs[left]
	}

	type item struct {
		word  Word
		timed bool
	}
	out := []item{}
	alone := []Word{}
	flush := func() {
		stretch := []Word{}
		keep := func() {
			if len(stretch) >= keptRun && !repeats(stretch) {
				for _, w := range stretch {
					out = append(out, item{w, true})
				}
			}
			stretch = nil
		}
		for _, w := range alone {
			if len(stretch) > 0 && w.Start-stretch[len(stretch)-1].End > runPause {
				keep()
			}
			stretch = append(stretch, w)
		}
		keep()
		alone = nil
	}
	for _, p := range pairs {
		if p.j < 0 {
			alone = append(alone, timed[p.i])
			continue
		}
		flush()
		if p.i < 0 {
			out = append(out, item{Word{Text: said[p.j]}, false})
		} else {
			out = append(out, item{Word{Start: timed[p.i].Start, End: timed[p.i].End, Text: said[p.j]}, true})
		}
	}
	flush()

	words := make([]Word, 0, len(out))
	for index, it := range out {
		if it.timed {
			words = append(words, it.word)
			continue
		}
		after := -1
		for k := index; k < len(out); k++ {
			if out[k].timed {
				after = k
				break
			}
		}
		begin := from
		if len(words) > 0 {
			begin = words[len(words)-1].End
		}
		limit, waiting := to, len(out)-index
		if after >= 0 {
			limit, waiting = out[after].word.Start, after-index
		}
		length := math.Max(0, math.Min(secondsPerWord, (limit-begin)/float64(waiting)))
		words = append(words, Word{Start: begin, End: begin + length, Text: it.word.Text})
	}
	return words
}

const (
	speechMargin       = 0.3
	strayWords         = 4
	strayShare         = 0.3
	paragraphPause     = 2
	paragraphSeconds   = 30
	microphoneSpeaker  = "mic"
	recorderName       = "Quem gravou"
	microphoneDominant = 2
)

// AudibleLevel is the loudness (RMS) under which a channel is silent: -40 dBFS (audio.ts).
var AudibleLevel = math.Pow(10, -40.0/20)

func distance(w Word, t Turn) float64 { return math.Max(math.Max(t.Start-w.End, w.Start-t.End), 0) }

func speakerOf(w Word, turns []Turn) string {
	best, most := "", 0.0
	for _, t := range turns {
		if overlap := math.Min(w.End, t.End) - math.Max(w.Start, t.Start); overlap > most {
			best, most = t.Speaker, overlap
		}
	}
	if best != "" || len(turns) == 0 {
		return best
	}
	nearest := turns[0]
	for _, t := range turns[1:] {
		if distance(w, t) < distance(w, nearest) {
			nearest = t
		}
	}
	return nearest.Speaker
}

// WordsInSpeech drops the words Whisper invents outside every stretch of voice (turns.ts).
func WordsInSpeech(words []Word, turns []Turn) []Word {
	if len(turns) == 0 {
		return words
	}
	kept := []Word{}
	for _, w := range words {
		middle := (w.Start + w.End) / 2
		for _, t := range turns {
			if middle >= t.Start-speechMargin && middle <= t.End+speechMargin {
				kept = append(kept, w)
				break
			}
		}
	}
	return kept
}

// WordTest says something of a word (whether it came from the microphone, from the computer).
type WordTest func(Word) bool

func never(Word) bool { return false }

// Volumes is the volume of each channel every `Step` seconds (RMS, 0 to 1): the part `volume` of a recording (T202).
type Volumes struct {
	Step       float64
	Microphone []float32
	Computer   []float32
}

const volumeFloorDB = -90

func rmsOfByte(b byte) float32 {
	if b == 0 {
		return 0
	}
	return float32(math.Pow(10, (float64(b)/255*-volumeFloorDB+volumeFloorDB)/20))
}

// VolumesOfPart reads the part `volume` the recording kept (`{ step, microphone, computer }`, one byte a window, base64).
func VolumesOfPart(raw string) (Volumes, error) {
	var part struct {
		Step       float64 `json:"step"`
		Microphone string  `json:"microphone"`
		Computer   string  `json:"computer"`
	}
	if err := json.Unmarshal([]byte(raw), &part); err != nil || part.Step <= 0 {
		return Volumes{}, fmt.Errorf("volume: %v", err)
	}
	levels := func(text string) ([]float32, error) {
		bytes, err := base64.StdEncoding.DecodeString(text)
		if err != nil {
			return nil, err
		}
		out := make([]float32, len(bytes))
		for i, b := range bytes {
			out[i] = rmsOfByte(b)
		}
		return out, nil
	}
	microphone, err := levels(part.Microphone)
	if err != nil {
		return Volumes{}, err
	}
	computer, err := levels(part.Computer)
	if err != nil {
		return Volumes{}, err
	}
	return Volumes{Step: part.Step, Microphone: microphone, Computer: computer}, nil
}

func (v Volumes) loudness(levels []float32, from, to float64) float64 {
	first := max(0, int(math.Floor(from/v.Step)))
	last := min(len(levels)-1, int(math.Ceil(to/v.Step))-1)
	energy, weight := 0.0, 0.0
	for i := first; i <= last; i++ {
		overlap := math.Min(to, float64(i+1)*v.Step) - math.Max(from, float64(i)*v.Step)
		if overlap <= 0 {
			continue
		}
		level := float64(levels[i])
		energy += level * level * overlap
		weight += overlap
	}
	if weight == 0 {
		return 0
	}
	return math.Sqrt(energy / weight)
}

// Tests are the words of the microphone (who recorded) and of the computer, as `microphoneWords` and `computerWords` in turns.ts.
func (v Volumes) Tests() (microphone, computer WordTest) {
	heard := false
	for _, level := range v.Computer {
		if float64(level) >= AudibleLevel {
			heard = true
			break
		}
	}
	if !heard || v.Step <= 0 {
		return never, never
	}
	microphone = func(w Word) bool {
		mic := v.loudness(v.Microphone, w.Start, w.End)
		return mic >= AudibleLevel && mic > v.loudness(v.Computer, w.Start, w.End)*microphoneDominant
	}
	computer = func(w Word) bool {
		heard := v.loudness(v.Computer, w.Start, w.End)
		return heard >= AudibleLevel && heard > v.loudness(v.Microphone, w.Start, w.End)
	}
	return microphone, computer
}

func microphoneSpeakers(words []Word, turns []Turn, fromMicrophone, fromComputer WordTest) map[string]bool {
	out := map[string]bool{}
	if len(turns) == 0 {
		return out
	}
	type tally struct{ microphone, mine, theirs int }
	count := map[string]*tally{}
	for _, w := range words {
		speaker := speakerOf(w, turns)
		t := count[speaker]
		if t == nil {
			t = &tally{}
			count[speaker] = t
		}
		if fromMicrophone(w) {
			t.microphone++
		}
		if fromComputer(w) {
			t.theirs++
		} else {
			t.mine++
		}
	}
	for speaker, t := range count {
		if t.microphone > 0 && t.mine > t.theirs {
			out[speaker] = true
		}
	}
	return out
}

func endsSentence(text string) bool {
	trimmed := strings.TrimSpace(text)
	return strings.HasSuffix(trimmed, ".") || strings.HasSuffix(trimmed, "!") || strings.HasSuffix(trimmed, "?") || strings.HasSuffix(trimmed, "…")
}

// sentenceSpeakers: a sentence stays with whoever said most of it (a few words given to someone else are a slip of the voice split).
func sentenceSpeakers(words []Word, speakers []string) []string {
	out := append([]string(nil), speakers...)
	start := 0
	for index := range words {
		if !endsSentence(words[index].Text) {
			continue
		}
		order := []string{}
		count := map[string]int{}
		for at := start; at <= index; at++ {
			if _, seen := count[speakers[at]]; !seen {
				order = append(order, speakers[at])
			}
			count[speakers[at]]++
		}
		main, most := order[0], count[order[0]]
		for _, speaker := range order[1:] {
			if count[speaker] > most {
				main, most = speaker, count[speaker]
			}
		}
		total := index + 1 - start
		if stray := total - most; stray <= strayWords && float64(stray) <= float64(total)*strayShare {
			for at := start; at <= index; at++ {
				out[at] = main
			}
		}
		start = index + 1
	}
	return out
}

// BlocksFromWords makes the paragraphs of each speaker (turns.ts). `volumes` says which words are of who recorded (nil: no channels).
func BlocksFromWords(words []Word, turns []Turn, volumes *Volumes) []Block {
	fromMicrophone, fromComputer := WordTest(never), WordTest(never)
	if volumes != nil {
		fromMicrophone, fromComputer = volumes.Tests()
	}
	yours := microphoneSpeakers(words, turns, fromMicrophone, fromComputer)
	theirs := []Turn{}
	for _, t := range turns {
		if !yours[t.Speaker] {
			theirs = append(theirs, t)
		}
	}
	sideOf := func(w Word) string {
		if fromMicrophone(w) {
			return microphoneSpeaker
		}
		speaker := speakerOf(w, turns)
		if !yours[speaker] {
			return speaker
		}
		if !fromComputer(w) {
			return microphoneSpeaker
		}
		if len(theirs) > 0 {
			return speakerOf(w, theirs)
		}
		return speaker
	}
	spoken := []Word{}
	for _, w := range words {
		if strings.TrimSpace(w.Text) != "" {
			spoken = append(spoken, w)
		}
	}
	sides := make([]string, len(spoken))
	for i, w := range spoken {
		sides[i] = sideOf(w)
	}
	speakers := sentenceSpeakers(spoken, sides)
	blocks := []Block{}
	for index, w := range spoken {
		text := strings.TrimSpace(w.Text)
		speaker := speakers[index]
		if n := len(blocks); n > 0 {
			last := &blocks[n-1]
			sameParagraph := !(endsSentence(last.Text) && (w.Start-last.End >= paragraphPause || last.End-last.Start >= paragraphSeconds))
			if last.Speaker == speaker && sameParagraph {
				last.Text += " " + text
				last.End = w.End
				continue
			}
		}
		blocks = append(blocks, Block{Speaker: speaker, Start: w.Start, End: w.End, Text: text})
	}
	return blocks
}

// SpeakersOf names the voices: who recorded by the account's name (else "Quem gravou"), the others "Falante N" (turns.ts).
func SpeakersOf(blocks []Block, recorder string) []Speaker {
	ids := []string{}
	seen := map[string]bool{}
	for _, b := range blocks {
		if b.Speaker != "" && !seen[b.Speaker] {
			seen[b.Speaker] = true
			ids = append(ids, b.Speaker)
		}
	}
	out := make([]Speaker, len(ids))
	for index, id := range ids {
		name := fmt.Sprintf("Falante %d", index+1)
		if id == microphoneSpeaker {
			name = strings.TrimSpace(recorder)
			if name == "" {
				name = recorderName
			}
		}
		out[index] = Speaker{ID: id, Name: name}
	}
	return out
}

func clockTime(seconds float64) string {
	total := int(math.Max(0, math.Floor(seconds)))
	rest := fmt.Sprintf("%02d:%02d", (total%3600)/60, total%60)
	if hours := total / 3600; hours > 0 {
		return fmt.Sprintf("%d:%s", hours, rest)
	}
	return rest
}

// ClockTime is a moment as the app writes it: "mm:ss", or "h:mm:ss" past an hour (export.ts, clockTime).
func ClockTime(seconds float64) string { return clockTime(seconds) }

// TranscriptText is the text of the note: one line a block, "Nome [mm:ss]: fala" (export.ts).
func TranscriptText(blocks []Block, speakers []Speaker) string {
	names := map[string]string{}
	for _, s := range speakers {
		names[s.ID] = s.Name
	}
	var out strings.Builder
	for _, b := range blocks {
		if b.Speaker == "" {
			fmt.Fprintf(&out, "[%s] %s\n", clockTime(b.Start), b.Text)
			continue
		}
		name, ok := names[b.Speaker]
		if !ok {
			name = b.Speaker
		}
		fmt.Fprintf(&out, "%s [%s]: %s\n", name, clockTime(b.Start), b.Text)
	}
	return out.String()
}
