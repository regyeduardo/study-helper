package langs

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/regyeduardo/study-helper/api/internal/ai"
)

// "Reportar" (owner, 23/11, wireframe C): a bad card is made again another way, by the other model and with the reason. A test card
// belongs to an item shared by everyone: the item's test cards are made again, kept in R2 as a new version and replace the old ones
// in every text that has the item. A card of the text's own sentences is made again only in that text.

// Reasons are the problems the person picks.
var Reasons = map[string]string{
	"two_right":    "Duas opções estão certas",
	"wrong_answer": "A resposta certa está errada",
	"bad_audio":    "O áudio está ruim",
	"confusing":    "O enunciado confunde",
	"other":        "Outro problema",
}

// ErrInvalidReason is a reason not in the list.
var ErrInvalidReason = errors.New("invalid_reason")

type reportedCard struct {
	part, item, model, language, name string
	card                              Card
	lines                             []string
}

func reported(db *sql.DB, user, code, textID, cardID string) (reportedCard, error) {
	var r reportedCard
	var data, body string
	err := db.QueryRow(`SELECT tc.part, COALESCE(c.item_id, ''), c.data, COALESCE(t.model, ''), t.language, l.name, t.body FROM lang_text_cards tc
		JOIN lang_cards c ON c.user_id = tc.user_id AND c.language = tc.language AND c.id = tc.card_id
		JOIN lang_texts t ON t.user_id = tc.user_id AND t.id = tc.text_id
		JOIN lang_languages l ON l.user_id = t.user_id AND l.code = t.language
		WHERE tc.user_id = ? AND tc.text_id = ? AND tc.card_id = ? AND t.language = ?`, user, textID, cardID, strings.ToLower(code)).
		Scan(&r.part, &r.item, &data, &r.model, &r.language, &r.name, &body)
	if errors.Is(err, sql.ErrNoRows) {
		return r, ErrNotFound
	}
	if err != nil {
		return r, err
	}
	if err := json.Unmarshal([]byte(data), &r.card); err != nil {
		return r, err
	}
	r.lines = Lines(body)
	return r, nil
}

// Report checks the card and makes it again in the background (the person goes on studying; the new card comes next time).
func (g *Generator) Report(user, code, textID, cardID, reason, note string) error {
	if _, ok := Reasons[reason]; !ok {
		return ErrInvalidReason
	}
	if _, err := reported(g.DB, user, code, textID, cardID); err != nil {
		return err
	}
	g.working.Add(1)
	go func() {
		defer g.working.Done()
		if err := g.ReportNow(context.Background(), user, code, textID, cardID, reason, note); err != nil {
			log.Printf("langs: card %s of %s not made again: %v", cardID, textID, err)
		}
	}()
	return nil
}

// otherFirst is the models with the one that made the card last (another way).
func otherFirst(models []ai.Model, used string) []ai.Model {
	out := []ai.Model{}
	for _, model := range models {
		if model.ID != used {
			out = append(out, model)
		}
	}
	for _, model := range models {
		if model.ID == used {
			out = append(out, model)
		}
	}
	return out
}

// askJSON calls the models in order until one gives an answer `accept` takes.
func (g *Generator) askJSON(ctx context.Context, models []ai.Model, prompt string, accept func(string) bool) (string, error) {
	var last error = ai.ErrProviderDown
	for _, model := range models {
		for try := 0; try < 2; try++ {
			answer, err := g.call(ctx, model, prompt)
			if err != nil {
				last = err
				break
			}
			if accept(stripFence(answer)) {
				return model.ID, nil
			}
			last = errInvalidContent
		}
	}
	return "", last
}

// ReportNow makes the card again now.
func (g *Generator) ReportNow(ctx context.Context, user, code, textID, cardID, reason, note string) error {
	r, err := reported(g.DB, user, code, textID, cardID)
	if err != nil {
		return err
	}
	if r.item != "" {
		return g.remakeItem(ctx, user, r, reason, note)
	}
	return g.remakeCard(ctx, user, textID, r, reason, note)
}

func complaint(reason, note string) string {
	text := Reasons[reason]
	if note = strings.TrimSpace(note); note != "" {
		text += ` ("` + note + `")`
	}
	return text
}

func (g *Generator) remakeItem(ctx context.Context, user string, r reportedCard, reason, note string) error {
	stored, err := g.Cache.Get(ctx, r.language, r.item)
	if err != nil {
		items, err := textItems(g.DB, user, r.language, "")
		if err != nil {
			return err
		}
		it, ok := items.ByID[r.item]
		if !ok {
			it, err = itemOfText(g.DB, user, r.language, r.item)
			if err != nil {
				return err
			}
		}
		stored = CachedItem{ID: r.item, Item: it, Model: r.model, Version: 1}
	}
	if len(stored.Item.Test) == 0 {
		stored.Item.Test = []Card{r.card}
	}
	current, _ := json.Marshal(stored.Item.Test)
	bad, _ := json.Marshal(r.card)
	prompt := fmt.Sprintf(`You write study cards for a Brazilian learning %s (code "%s").
A person reported this card of the item "%s" (%s, meaning "%s"): %s.
Reported card: %s
All the current test cards of the item: %s

Write the item's test cards again, in a DIFFERENT way: other example sentences, other distractors, avoiding the reported problem.
2 or 3 closed cards, AT LEAST ONE listening card (listen_mc, dictation or dictation_gap); your own example sentences, never someone's text.
Same card format as before ("q" in Brazilian Portuguese; choice cards with exactly 5 options, hard distractors, never two equivalent options;
in "gap" and "dictation_gap" the sentence with "___" goes in "text").
Answer with ONE JSON object only: {"test": [cards]}`, r.name, r.language, stored.Item.Label, stored.Item.Kind, stored.Item.Meaning, complaint(reason, note), bad, current)
	var cards []Card
	used, err := g.askJSON(ctx, otherFirst(g.Models, stored.Model), prompt, func(answer string) bool {
		var got struct {
			Test []Card `json:"test"`
		}
		if json.Unmarshal([]byte(answer), &got) != nil {
			return false
		}
		cards = validTests(r.item, got.Test)
		return len(cards) > 0
	})
	if err != nil {
		return err
	}
	stored.Item.Test = cards
	stored.Version++
	stored.Model = used
	stored.At = Stamp(g.now())
	stored.Reports = append(stored.Reports, Report{Card: r.card.ID, Reason: reason, Note: strings.TrimSpace(note), At: stored.At})
	if err := g.Cache.Put(ctx, r.language, stored); err != nil && !errors.Is(err, errNoCache) {
		return err
	}
	return replaceItemTests(g.DB, r.language, r.item, cards)
}

func itemOfText(db *sql.DB, user, code, id string) (Item, error) {
	rows, err := db.Query(`SELECT `+itemColumns+` FROM lang_items i WHERE i.user_id = ? AND i.language = ? AND i.id = ?`, user, code, id)
	if err != nil {
		return Item{}, err
	}
	defer rows.Close()
	if !rows.Next() {
		return Item{}, ErrNotFound
	}
	_, it, err := scanItem(rows)
	return it, err
}

// validTests are the cards that pass, with the item's ids.
func validTests(item string, cards []Card) []Card {
	out := []Card{}
	for _, card := range cards {
		fixBlanks(&card)
		if len(checkCard(card, nil)) > 0 {
			continue
		}
		card.Covers = []string{item}
		card.Needs = nil
		out = append(out, card)
	}
	for n := range out {
		out[n].ID = fmt.Sprintf("%s__%d", item, n+1)
	}
	return out
}

// replaceItemTests puts the item's new test cards in every account that has the item (the cards are the language's, 24/11): a card
// that keeps its id (item__n) keeps its schedule; one left over goes away; every text with the item uses the new ones.
func replaceItemTests(db *sql.DB, code, item string, cards []Card) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	rows, err := tx.Query(`SELECT DISTINCT user_id FROM lang_items WHERE language = ? AND id = ?`, code, item)
	if err != nil {
		return err
	}
	users := []string{}
	for rows.Next() {
		var user string
		if err := rows.Scan(&user); err != nil {
			rows.Close()
			return err
		}
		users = append(users, user)
	}
	rows.Close()
	keep := make([]any, 0, len(cards))
	marks := make([]string, 0, len(cards))
	for _, card := range cards {
		keep = append(keep, card.ID)
		marks = append(marks, "?")
	}
	for _, user := range users {
		args := append([]any{user, code, item}, keep...)
		if _, err := tx.Exec(`DELETE FROM lang_cards WHERE user_id = ? AND language = ? AND item_id = ? AND id NOT IN (`+strings.Join(marks, ",")+`)`, args...); err != nil {
			return err
		}
		for _, card := range cards {
			data, _ := json.Marshal(card)
			if _, err := tx.Exec(`INSERT INTO lang_cards (user_id, language, id, item_id, type, skill, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT (user_id, language, id) DO UPDATE SET item_id = excluded.item_id, type = excluded.type, skill = excluded.skill, data = excluded.data`,
				user, code, card.ID, item, card.Type, card.Skill, string(data), Stamp(time.Now())); err != nil {
				return err
			}
			if _, err := tx.Exec(`DELETE FROM lang_card_items WHERE user_id = ? AND language = ? AND card_id = ?`, user, code, card.ID); err != nil {
				return err
			}
			if _, err := tx.Exec(`INSERT OR IGNORE INTO lang_card_items (user_id, language, card_id, item_id, role) VALUES (?, ?, ?, ?, 'covers')`, user, code, card.ID, item); err != nil {
				return err
			}
		}
		texts, err := tx.Query(`SELECT ti.text_id, ti.position FROM lang_text_items ti JOIN lang_texts t ON t.user_id = ti.user_id AND t.id = ti.text_id AND t.language = ?
			WHERE ti.user_id = ? AND ti.item_id = ?`, code, user, item)
		if err != nil {
			return err
		}
		type place struct {
			text     string
			position int
		}
		places := []place{}
		for texts.Next() {
			var p place
			if err := texts.Scan(&p.text, &p.position); err != nil {
				texts.Close()
				return err
			}
			places = append(places, p)
		}
		texts.Close()
		for _, p := range places {
			position := p.position
			_ = tx.QueryRow(`SELECT MIN(tc.position) FROM lang_text_cards tc JOIN lang_cards c ON c.user_id = tc.user_id AND c.language = tc.language AND c.id = tc.card_id
				WHERE tc.user_id = ? AND tc.text_id = ? AND c.item_id = ? AND tc.part = 'test'`, user, p.text, item).Scan(&position)
			for _, card := range cards {
				if _, err := tx.Exec(`INSERT OR IGNORE INTO lang_text_cards (user_id, text_id, language, card_id, part, position) VALUES (?, ?, ?, ?, 'test', ?)`,
					user, p.text, code, card.ID, position); err != nil {
					return err
				}
			}
		}
	}
	return tx.Commit()
}

func (g *Generator) remakeCard(ctx context.Context, user, textID string, r reportedCard, reason, note string) error {
	items, err := textItems(g.DB, user, r.language, textID)
	if err != nil {
		return err
	}
	bad, _ := json.Marshal(r.card)
	prompt := fmt.Sprintf(`You write study cards for a Brazilian learning %s (code "%s") from this text:
%s

A person reported this card: %s.
Reported card: %s

Write this card again in a DIFFERENT way, avoiding the reported problem: the same skill ("%s"), from the sentences of the text, covering the
same items %v. Same card format ("q" in Brazilian Portuguese; choice cards with exactly 5 options, hard distractors, never two equivalent
options; in "gap" and "dictation_gap" the sentence with "___" goes in "text").
Answer with ONE JSON object only: {"card": {...}}`, r.name, r.language, strings.Join(r.lines, "\n"), complaint(reason, note), bad, r.card.Skill, r.card.Covers)
	var card Card
	_, err = g.askJSON(ctx, otherFirst(g.Models, r.model), prompt, func(answer string) bool {
		var got struct {
			Card Card `json:"card"`
		}
		if json.Unmarshal([]byte(answer), &got) != nil {
			return false
		}
		card = got.Card
		fixBlanks(&card)
		if card.DP == "" {
			card.DP = r.card.DP
		}
		card.Covers = filter(card.Covers, func(id string) bool { _, ok := items.ByID[id]; return ok })
		if len(card.Covers) == 0 {
			card.Covers = r.card.Covers
		}
		card.ID = r.card.ID
		return len(checkCard(card, nil)) == 0
	})
	if err != nil {
		return err
	}
	data, _ := json.Marshal(card)
	tx, err := g.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE lang_cards SET type = ?, skill = ?, data = ? WHERE user_id = ? AND language = ? AND id = ?`, card.Type, card.Skill, string(data), user, r.language, card.ID); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM lang_card_items WHERE user_id = ? AND language = ? AND card_id = ?`, user, r.language, card.ID); err != nil {
		return err
	}
	for role, list := range map[string][]string{"covers": card.Covers, "needs": card.Needs} {
		for _, id := range list {
			if _, err := tx.Exec(`INSERT OR IGNORE INTO lang_card_items (user_id, language, card_id, item_id, role) VALUES (?, ?, ?, ?, ?)`, user, r.language, card.ID, id, role); err != nil {
				return err
			}
		}
	}
	return tx.Commit()
}
