package generate

import (
	"context"
	"strings"
	"time"

	"github.com/regyeduardo/study-helper/api/internal/prompts"
)

const mostCards = 60

// Card is a memorization card (StudyCard): new ones are in box 0, due today.
type Card struct {
	ID    string `json:"id"`
	Front string `json:"front"`
	Back  string `json:"back"`
	Box   int    `json:"box"`
	Due   string `json:"due"`
}

// Today is the day as the app writes it (src/lib/generation/cards.ts, today: the UTC date).
func Today(now time.Time) string { return now.UTC().Format("2006-01-02") }

func cardsOf(list any, day string) []Card {
	items, _ := list.([]any)
	out := []Card{}
	for _, item := range items {
		row, _ := item.(map[string]any)
		front, _ := row["frente"].(string)
		back, _ := row["verso"].(string)
		if front, back = strings.TrimSpace(front), strings.TrimSpace(back); front != "" && back != "" {
			out = append(out, Card{ID: NewID(), Front: front, Back: back, Box: 0, Due: day})
		}
	}
	return out
}

// spread takes up to `most` cards one from each part in turn, so the end of a long note is not left out; the note's order kept.
func spread(parts [][]Card, most int) []Card {
	taken := make([]int, len(parts))
	left := most
	for left > 0 {
		moved := false
		for index, part := range parts {
			if left > 0 && taken[index] < len(part) {
				taken[index]++
				left--
				moved = true
			}
		}
		if !moved {
			break
		}
	}
	out := []Card{}
	for index, part := range parts {
		out = append(out, part[:taken[index]]...)
	}
	return out
}

// Cards are the cards of the WHOLE note (read in parts) and the name the AI gives the deck (src/lib/generation/cards.ts).
func Cards(ctx context.Context, chat Chat, content, instruction, day string) ([]Card, string, error) {
	parts := [][]Card{}
	for _, piece := range Chunks(strings.TrimSpace(content)) {
		answer, err := chat(ctx, WithInstruction(piece, instruction), prompts.Text("CARDS_PROMPT"), 0)
		if err != nil {
			return nil, "", err
		}
		parts = append(parts, cardsOf(ExtractJSON(answer)["cartoes"], day))
	}
	cards := spread(parts, mostCards)
	if len(cards) == 0 {
		return cards, "", nil
	}
	fronts := make([]string, len(cards))
	for i, card := range cards {
		fronts[i] = card.Front
	}
	name, err := NameArtifact(ctx, chat, strings.Join(fronts, "\n"), "cartoes", instruction)
	return cards, name, err
}
