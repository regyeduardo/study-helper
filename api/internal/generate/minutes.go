package generate

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/regyeduardo/study-helper/api/internal/prompts"
	"github.com/regyeduardo/study-helper/api/internal/transcribe"
)

// The Ata written in two passes (src/lib/generation/minutes.ts, buildMinutes): each piece of the transcription (with the marks and the
// screens read in the moments they happened) becomes a partial Ata; with more than one piece, the AI joins them; each point links to
// the moment it was said.

const quoteHeadWords = 5

var edgeQuotes = regexp.MustCompile(`^"+|"+$`)

func textOf(value any) string {
	text, _ := value.(string)
	return text
}

func plainText(value string) string {
	return strings.TrimSpace(notLetters.ReplaceAllString(transcribe.WithoutAccents(value), " "))
}

type mark struct {
	At   float64 `json:"at"`
	Kind string  `json:"kind"`
	Text string  `json:"text"`
}

func marksOf(rec *transcribe.Recording) []mark {
	out := []mark{}
	_ = json.Unmarshal(rec.Marks, &out)
	for _, frame := range rec.Frames {
		out = append(out, mark{At: frame.At, Kind: "screen", Text: frame.Text})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].At < out[j].At })
	return out
}

func markLine(m mark) string {
	switch m.Kind {
	case "screen":
		return ">> TELA [" + transcribe.ClockTime(m.At) + "]: " + m.Text + "\n"
	case "mark":
		return ">> MOMENTO MARCADO [" + transcribe.ClockTime(m.At) + "]\n"
	}
	return ">> ANOTAÇÃO [" + transcribe.ClockTime(m.At) + "]: " + m.Text + "\n"
}

func speechLine(rec *transcribe.Recording, block transcribe.Block) string {
	return transcribe.TranscriptText([]transcribe.Block{block}, rec.Speakers)
}

func markedTranscript(rec *transcribe.Recording) string {
	marks := marksOf(rec)
	var lines strings.Builder
	for index, block := range rec.Blocks {
		if index == 0 {
			for len(marks) > 0 && marks[0].At < block.Start {
				lines.WriteString(markLine(marks[0]))
				marks = marks[1:]
			}
		}
		lines.WriteString(speechLine(rec, block))
		for len(marks) > 0 && (index+1 >= len(rec.Blocks) || marks[0].At < rec.Blocks[index+1].Start) {
			lines.WriteString(markLine(marks[0]))
			marks = marks[1:]
		}
	}
	return lines.String()
}

func momentOf(item map[string]any, rec *transcribe.Recording) (float64, bool) {
	citation := plainText(strings.TrimSpace(edgeQuotes.ReplaceAllString(strings.TrimSpace(textOf(item["citacao"])), "")))
	if rec == nil || citation == "" {
		return 0, false
	}
	words := strings.Split(citation, " ")
	head := strings.Join(words[:min(len(words), quoteHeadWords)], " ")
	hour := strings.TrimSpace(textOf(item["hora"]))
	timed := []transcribe.Block{}
	for _, block := range rec.Blocks {
		if transcribe.ClockTime(block.Start) == hour {
			timed = append(timed, block)
		}
	}
	holding := func(list []transcribe.Block, wanted string) *transcribe.Block {
		for i := range list {
			if strings.Contains(plainText(list[i].Text), wanted) {
				return &list[i]
			}
		}
		return nil
	}
	found := holding(timed, citation)
	if found == nil {
		found = holding(rec.Blocks, citation)
	}
	if found == nil {
		found = holding(rec.Blocks, head)
	}
	if found == nil && len(timed) > 0 {
		found = &timed[0]
	}
	if found == nil {
		return 0, false
	}
	body := plainText(found.Text)
	at := strings.Index(body, citation)
	if at < 0 {
		at = strings.Index(body, head)
	}
	if at > 0 && found.End > found.Start {
		// the place in letters, as JavaScript counts them
		letters := len([]rune(body[:at]))
		return found.Start + (found.End-found.Start)*float64(letters)/float64(len([]rune(body))), true
	}
	return found.Start, true
}

func momentLink(item map[string]any, rec *transcribe.Recording) string {
	at, ok := momentOf(item, rec)
	if !ok {
		return ""
	}
	return fmt.Sprintf(" [▸ %s](#t=%d)", transcribe.ClockTime(at), int(math.Floor(at)))
}

// RenderMinutes writes the Ata of the AI's answer (renderMinutes).
func RenderMinutes(minutes map[string]any, rec *transcribe.Recording) string {
	subject := strings.TrimSpace(textOf(minutes["assunto"]))
	if subject == "" {
		subject = "Reunião"
	}
	parts := []string{"# " + subject, ""}
	for _, theme := range itemsOf(minutes["temas"]) {
		points := []map[string]any{}
		for _, point := range itemsOf(theme["pontos"]) {
			if strings.TrimSpace(textOf(point["texto"])) != "" {
				points = append(points, point)
			}
		}
		if len(points) == 0 {
			continue
		}
		title := strings.TrimSpace(textOf(theme["tema"]))
		if title == "" {
			title = "Outros pontos"
		}
		parts = append(parts, "### "+title)
		for _, point := range points {
			parts = append(parts, "- "+strings.TrimSpace(textOf(point["texto"]))+momentLink(point, rec))
		}
		parts = append(parts, "")
	}
	steps := []map[string]any{}
	for _, step := range itemsOf(minutes["passos"]) {
		if strings.TrimSpace(textOf(step["texto"])) != "" {
			steps = append(steps, step)
		}
	}
	if len(steps) > 0 {
		parts = append(parts, "**Próximos passos**")
		for _, step := range steps {
			who, when := strings.TrimSpace(textOf(step["quem"])), strings.TrimSpace(textOf(step["quando"]))
			if who == "" {
				who = "sem dono"
			}
			if when == "" {
				when = "sem prazo"
			}
			parts = append(parts, "- [ ] "+strings.TrimSpace(textOf(step["texto"]))+" — "+who+" · "+when+momentLink(step, rec))
		}
		parts = append(parts, "")
	}
	return strings.TrimSpace(strings.Join(parts, "\n")) + "\n"
}

// MinutesFileName is the name of an Ata: "2026-11-28 14-05 - Assunto", in the person's own time.
func MinutesFileName(subject string, when time.Time) string {
	if subject = strings.TrimSpace(subject); subject == "" {
		subject = "Reunião"
	}
	return when.Format("2006-01-02 15-04") + " - " + subject
}

// Minutes writes the Ata of a meeting in two passes; an answer out of format is asked once more, and then the Ata fails saying why.
func Minutes(ctx context.Context, chat Chat, transcript string, rec *transcribe.Recording, instruction string) (string, string, error) {
	source := transcript
	if rec != nil {
		source = markedTranscript(rec)
	}
	pieces := []map[string]any{}
	for _, piece := range Chunks(source) {
		var written map[string]any
		for try := 0; try < 2 && written == nil; try++ {
			answer, err := chat(ctx, WithInstruction(piece, instruction), prompts.Text("MINUTES_EXTRACT_PROMPT"), 0)
			if err != nil {
				return "", "", err
			}
			written = ExtractJSON(answer)
		}
		if written == nil {
			return "", "", errors.New("A IA não devolveu a ata no formato esperado, nem na segunda tentativa. Nada foi escrito; tente de novo.")
		}
		pieces = append(pieces, written)
	}
	joined := map[string]any{"assunto": textOf(pieces[0]["assunto"]), "temas": []any{}, "passos": []any{}}
	for _, piece := range pieces {
		for _, theme := range itemsOf(piece["temas"]) {
			joined["temas"] = append(joined["temas"].([]any), theme)
		}
		for _, step := range itemsOf(piece["passos"]) {
			joined["passos"] = append(joined["passos"].([]any), step)
		}
	}
	minutes := joined
	if len(pieces) > 1 {
		raw, _ := marshalPlain(map[string]any{"partes": pieces})
		answer, err := chat(ctx, WithInstruction(raw, instruction), prompts.Text("MINUTES_VERIFY_PROMPT"), 0)
		if err != nil {
			return "", "", err
		}
		if verified := ExtractJSON(answer); verified != nil {
			minutes = verified
		}
	}
	subject := strings.TrimSpace(textOf(minutes["assunto"]))
	if subject == "" {
		subject = "Reunião"
	}
	return RenderMinutes(minutes, rec), subject, nil
}
