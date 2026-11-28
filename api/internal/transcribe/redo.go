package transcribe

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/regyeduardo/study-helper/api/internal/prompts"
)

// RedoTranscript is "Refazer a transcrição" (src/lib/generation/reviewer.ts, redoTranscript): the AI reads what is wrong, as the person
// said it, with the terms, the voices and the screen, and gives back the words to change and the speeches of another voice.
func RedoTranscript(ctx context.Context, rec Recording, instruction string, chat Chat, terms string) (Recording, error) {
	if len(rec.Blocks) == 0 || strings.TrimSpace(instruction) == "" {
		return rec, nil
	}
	context := "O que está errado, segundo quem gravou: " + strings.TrimSpace(instruction) + "\n\n"
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
	for index, block := range rec.Blocks {
		who := ""
		if block.Speaker != "" {
			name, ok := nameOf[block.Speaker]
			if !ok {
				name = block.Speaker
			}
			who = name + ": "
		}
		lines[index] = strconv.Itoa(index+1) + " | " + who + block.Text
	}
	type reassignment struct {
		speech int
		who    string
	}
	corrections := []correction{}
	reassignments := []reassignment{}
	for _, batch := range batchesOf(lines) {
		answer, err := chat(ctx, context+strings.Join(batch, "\n"), prompts.Text("TRANSCRIPT_REDO_PROMPT"))
		if err != nil {
			return rec, err
		}
		parsed := ExtractJSON(answer)
		for _, item := range listOf(parsed, "correcoes") {
			heard, _ := item["de"].(string)
			meant, _ := item["para"].(string)
			corrections = append(corrections, correction{speech: speechNumber(item["fala"]), heard: heard, meant: meant})
		}
		for _, item := range listOf(parsed, "falantes") {
			who, _ := item["quem"].(string)
			if who = strings.TrimSpace(who); who != "" {
				reassignments = append(reassignments, reassignment{speech: speechNumber(item["fala"]), who: who})
			}
		}
	}
	blocks := append([]Block(nil), rec.Blocks...)
	for _, c := range corrections {
		if c.speech < 1 || c.speech > len(blocks) {
			continue
		}
		block := blocks[c.speech-1]
		if c.heard == "" || strings.TrimSpace(c.meant) == "" || !strings.Contains(block.Text, c.heard) {
			continue
		}
		if block.Original == "" {
			block.Original = block.Text
		}
		block.Text = strings.Replace(block.Text, c.heard, c.meant, 1)
		blocks[c.speech-1] = block
	}
	speakers := append([]Speaker(nil), rec.Speakers...)
	for _, r := range reassignments {
		if r.speech < 1 || r.speech > len(blocks) {
			continue
		}
		id := ""
		for _, s := range speakers {
			if strings.EqualFold(s.Name, r.who) {
				id = s.ID
				break
			}
		}
		if id == "" {
			id = fmt.Sprintf("named_%d", len(speakers))
			speakers = append(speakers, Speaker{ID: id, Name: r.who})
		}
		blocks[r.speech-1].Speaker = id
	}
	rec.Blocks, rec.Speakers = blocks, speakers
	return rec, nil
}

// speechNumber is Number(fala) of JavaScript for the numbers the AI writes (a number or a text of one); 0 for anything else.
func speechNumber(value any) int {
	switch v := value.(type) {
	case float64:
		if v == float64(int(v)) {
			return int(v)
		}
	case string:
		if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil {
			return n
		}
	}
	return 0
}

// batchesOf: the numbered speeches in batches of at most 12000 letters (reviewer.ts, batches).
func batchesOf(lines []string) [][]string {
	out := [][]string{{}}
	size := 0
	for _, line := range lines {
		length := len([]rune(line))
		if size+length > chunkChars && len(out[len(out)-1]) > 0 {
			out = append(out, []string{})
			size = 0
		}
		out[len(out)-1] = append(out[len(out)-1], line)
		size += length
	}
	return out
}
