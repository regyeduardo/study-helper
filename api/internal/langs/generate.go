package langs

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/regyeduardo/study-helper/api/internal/ai"
)

// T024: the generation of a text (one at a time per account). The text the person sent stays whole; inside, the AI gets it in pieces,
// each with the items the language already has (to reuse their ids), and the pieces become one text. What the validator refuses goes
// back to the AI up to 2 times; a provider that fails gives way to the next model of the use.

// Chatter is the AI that writes the cards (ai.Client in the server; a fake in the tests).
type Chatter interface {
	Chat(ctx context.Context, model ai.Model, prompt string, asJSON bool) (string, error)
}

// Generator turns texts into items and cards.
type Generator struct {
	DB     *sql.DB
	AI     Chatter
	Models []ai.Model
	Now    func() time.Time
	// ChunkLines and ChunkChars bound each piece sent to the AI (10 lines, 1.500 characters when zero)
	ChunkLines int
	ChunkChars int
	// CallTimeout bounds one call to the AI (6 minutes when zero)
	CallTimeout time.Duration
	// Cache keeps every item for every account (R2); nil generates everything
	Cache *ItemCache

	mu       sync.Mutex
	queues   map[string][]string
	working  sync.WaitGroup
	progress map[string]GenProgress
}

// GenProgress is how far the generation of a text is (constitution IV): parts done of how many, when it started, when the last part
// came out and around when it ends (the average of the parts done so far times the parts left).
type GenProgress struct {
	Done      int    `json:"done"`
	Total     int    `json:"total"`
	StartedAt string `json:"startedAt"`
	LastAt    string `json:"lastAt,omitempty"`
	EndsAt    string `json:"endsAt,omitempty"`
}

type textKey struct{}

// ProgressOf is the generation of the text running now; nil when it did not start (waiting in the queue) or ended.
func (g *Generator) ProgressOf(textID string) *GenProgress {
	g.mu.Lock()
	defer g.mu.Unlock()
	p, ok := g.progress[textID]
	if !ok {
		return nil
	}
	return &p
}

func (g *Generator) mark(ctx context.Context, done, total int) {
	id, _ := ctx.Value(textKey{}).(string)
	if id == "" {
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.progress == nil {
		g.progress = map[string]GenProgress{}
	}
	now := g.now()
	p, ok := g.progress[id]
	if !ok || done == 0 {
		p = GenProgress{StartedAt: Stamp(now)}
	}
	p.Done, p.Total = done, total
	if done > 0 {
		p.LastAt = Stamp(now)
		if started, err := time.Parse("2006-01-02T15:04:05.000Z", p.StartedAt); err == nil && done < total {
			each := now.Sub(started) / time.Duration(done)
			p.EndsAt = Stamp(now.Add(each * time.Duration(total-done)))
		} else {
			p.EndsAt = ""
		}
	}
	g.progress[id] = p
}

func (g *Generator) unmark(textID string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	delete(g.progress, textID)
}

const fixTries = 2

var errInvalidContent = errors.New("invalid_content")

// Enqueue puts a text in the account's queue; the account's texts are generated one at a time, in order.
func (g *Generator) Enqueue(user, textID string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.queues == nil {
		g.queues = map[string][]string{}
	}
	queue, busy := g.queues[user]
	for _, id := range queue {
		if id == textID {
			return
		}
	}
	g.queues[user] = append(queue, textID)
	if busy {
		return
	}
	g.working.Add(1)
	go g.drain(user)
}

func (g *Generator) drain(user string) {
	defer g.working.Done()
	for {
		g.mu.Lock()
		queue := g.queues[user]
		if len(queue) == 0 {
			delete(g.queues, user)
			g.mu.Unlock()
			return
		}
		id := queue[0]
		g.mu.Unlock()
		if err := g.Run(context.Background(), user, id); err != nil {
			log.Printf("langs: text %s not generated: %v", id, err)
		}
		g.mu.Lock()
		g.queues[user] = g.queues[user][1:]
		g.mu.Unlock()
	}
}

// Wait is for the tests and the shutdown: every queue empty.
func (g *Generator) Wait() { g.working.Wait() }

func (g *Generator) now() time.Time {
	if g.Now != nil {
		return g.Now()
	}
	return time.Now()
}

// Pieces are the text's lines in groups for the AI.
func Pieces(lines []string, maxLines, maxChars int) [][]string {
	if maxLines <= 0 {
		maxLines = 10
	}
	if maxChars <= 0 {
		maxChars = 1500
	}
	out := [][]string{}
	var piece []string
	size := 0
	for _, line := range lines {
		length := utf8.RuneCountInString(line)
		if len(piece) > 0 && (len(piece) >= maxLines || size+length > maxChars) {
			out = append(out, piece)
			piece, size = nil, 0
		}
		piece = append(piece, line)
		size += length
	}
	if len(piece) > 0 {
		out = append(out, piece)
	}
	return out
}

// Run generates one text now and keeps the result (ready, or failed with the reason).
func (g *Generator) Run(ctx context.Context, user, textID string) error {
	code, name, body, err := Body(g.DB, user, textID)
	if err != nil {
		return err
	}
	defer g.unmark(textID)
	content, model, err := g.generate(context.WithValue(ctx, textKey{}, textID), user, code, name, Lines(body))
	if err != nil {
		reason := "provider_down"
		switch {
		case errors.Is(err, errInvalidContent):
			reason = "invalid_content"
		case errors.Is(err, ai.ErrNoKey):
			reason = "ai_not_configured"
		}
		if failErr := FailText(g.DB, user, textID, reason); failErr != nil {
			return failErr
		}
		return err
	}
	return SaveContent(g.DB, user, code, textID, content, model, g.now())
}

func (g *Generator) generate(ctx context.Context, user, code, name string, lines []string) (Content, string, error) {
	graph, base, err := Base(g.DB, user, code)
	if err != nil {
		return Content{}, "", err
	}
	merged := Content{Lines: lines, Equivalences: [][]string{}, Items: Items{ByID: map[string]Item{}}, Practice: []Card{}, Context: []Card{}}
	if existing, err := Equivalences(g.DB, user, code); err == nil {
		merged.Equivalences = existing
	}
	index := g.Cache.Index(ctx, code)
	fromCache := map[string]bool{}
	pieces := Pieces(lines, g.ChunkLines, g.ChunkChars)
	used := ""
	g.mark(ctx, 0, len(pieces))
	for n, piece := range pieces {
		// the person's own items of this piece, and the ready ones (everyone's), only those whose words are in the piece
		known := []BaseItem{}
		mine := []ReadyItem{}
		for _, item := range base {
			mine = append(mine, ReadyItem{ID: item.ID, Label: item.Label, Kind: item.Kind})
		}
		for _, item := range inPiece(mine, piece) {
			known = append(known, BaseItem{ID: item.ID, Label: item.Label, Kind: item.Kind, Needs: graph[item.ID]})
		}
		for _, id := range merged.Items.Keys {
			if _, inBase := graph[id]; !inBase {
				it := merged.Items.ByID[id]
				known = append(known, BaseItem{ID: id, Area: it.Area, Kind: it.Kind, Label: it.Label, Needs: it.Needs})
			}
		}
		ready := []ReadyItem{}
		for _, item := range inPiece(index, piece) {
			if _, done := merged.Items.ByID[item.ID]; !done {
				ready = append(ready, item)
			}
		}
		knownGraph := map[string][]string{}
		for id, needs := range graph {
			knownGraph[id] = needs
		}
		for _, item := range known {
			knownGraph[item.ID] = item.Needs
		}
		for _, item := range ready {
			if _, ok := knownGraph[item.ID]; !ok {
				knownGraph[item.ID] = nil
			}
		}
		prompt := Prompt(name, code, piece, known, ready, n+1, len(pieces))
		got, model, err := g.ask(ctx, prompt, knownGraph, merged.Equivalences)
		if err != nil {
			return Content{}, "", err
		}
		used = model
		// a ready item comes from R2 as it is (also when the AI wrote it again)
		for _, item := range ready {
			_, wrote := got.Items.ByID[item.ID]
			if !wrote && !contains(got.Reuse, item.ID) && !covered(got, item.ID) {
				continue
			}
			if stored, err := g.Cache.Get(ctx, code, item.ID); err == nil {
				got.Items.Add(item.ID, stored.Item)
				fromCache[item.ID] = true
			}
		}
		merge(&merged, got, n)
		g.mark(ctx, n+1, len(pieces))
	}
	Repair(&merged, graph)
	if problems := Validate(merged, graph); len(problems) > 0 || len(merged.Items.Keys) == 0 {
		return Content{}, "", fmt.Errorf("%w: %s", errInvalidContent, strings.Join(problems[:min(len(problems), 5)], "; "))
	}
	// every new item is kept for everyone
	for _, id := range merged.Items.Keys {
		if fromCache[id] {
			continue
		}
		if _, ready := g.Cache.Get(ctx, code, id); ready == nil {
			continue
		}
		_ = g.Cache.Put(ctx, code, CachedItem{ID: id, Item: merged.Items.ByID[id], Model: used, Version: 1, At: Stamp(g.now())})
	}
	return merged, used, nil
}

func contains(list []string, id string) bool {
	for _, item := range list {
		if item == id {
			return true
		}
	}
	return false
}

// covered says whether a card of the piece covers the item.
func covered(c Content, id string) bool {
	for _, list := range [][]Card{c.Practice, c.Context} {
		for _, card := range list {
			if contains(card.Covers, id) {
				return true
			}
		}
	}
	return false
}

// ask gets one valid piece: the first model that answers, its answer fixed up to 2 times.
func (g *Generator) ask(ctx context.Context, prompt string, known map[string][]string, groups [][]string) (Content, string, error) {
	var lastErr error = ai.ErrProviderDown
	for _, model := range g.Models {
		question := prompt
		for try := 0; try <= fixTries; try++ {
			answer, err := g.call(ctx, model, question)
			if err != nil {
				lastErr = err
				break // this model does not answer: the next one
			}
			var piece Content
			problems := []string{}
			if err := json.Unmarshal([]byte(stripFence(answer)), &piece); err != nil {
				problems = append(problems, "the answer is not the JSON object asked: "+err.Error())
			} else {
				piece.Lines = []string{"-"}
				piece.Equivalences = append(append([][]string{}, groups...), piece.Equivalences...)
				if dropped := Repair(&piece, known); len(dropped) > 0 {
					log.Printf("langs: %s dropped %d bad parts: %s", model.ID, len(dropped), strings.Join(dropped[:min(len(dropped), 5)], "; "))
				}
				problems = Validate(piece, known)
				if len(piece.Items.Keys) == 0 {
					problems = append(problems, "no valid item: every item needs label, meaning and 2 or 3 valid test cards")
				}
			}
			if len(problems) == 0 {
				return piece, model.ID, nil
			}
			lastErr = fmt.Errorf("%w: %s", errInvalidContent, strings.Join(problems[:min(len(problems), 5)], "; "))
			question = prompt + fixRequest(answer, problems)
		}
		if errors.Is(lastErr, errInvalidContent) {
			return Content{}, "", lastErr
		}
	}
	return Content{}, "", lastErr
}

func (g *Generator) call(ctx context.Context, model ai.Model, prompt string) (string, error) {
	limit := g.CallTimeout
	if limit <= 0 {
		limit = 6 * time.Minute
	}
	ctx, cancel := context.WithTimeout(ctx, limit)
	defer cancel()
	return g.AI.Chat(ctx, model, prompt, true)
}

func stripFence(answer string) string {
	answer = strings.TrimSpace(answer)
	if strings.HasPrefix(answer, "```") {
		answer = strings.TrimPrefix(answer, "```json")
		answer = strings.TrimPrefix(answer, "```")
		answer = strings.TrimSuffix(strings.TrimSpace(answer), "```")
	}
	return strings.TrimSpace(answer)
}

func fixRequest(answer string, problems []string) string {
	if len(problems) > 40 {
		problems = append(problems[:40], fmt.Sprintf("… and %d more", len(problems)-40))
	}
	return "\n\nYOUR PREVIOUS ANSWER (below) HAS PROBLEMS. Answer again with the whole JSON object fixed.\nProblems:\n- " +
		strings.Join(problems, "\n- ") + "\n\nPrevious answer:\n" + answer
}

// merge adds a piece to the text: an item already there stays as it came first; a card id already used gets the piece's number.
func merge(into *Content, piece Content, n int) {
	ids := map[string]bool{}
	for _, card := range into.Practice {
		ids[card.ID] = true
	}
	for _, card := range into.Context {
		ids[card.ID] = true
	}
	for _, key := range into.Items.Keys {
		for _, card := range into.Items.ByID[key].Test {
			ids[card.ID] = true
		}
	}
	fresh := func(card Card) Card {
		id := card.ID
		for k := n + 1; ids[id]; k++ {
			id = fmt.Sprintf("%s_%d", card.ID, k)
		}
		card.ID = id
		ids[id] = true
		return card
	}
	for _, key := range piece.Items.Keys {
		if _, seen := into.Items.ByID[key]; seen {
			continue
		}
		it := piece.Items.ByID[key]
		tests := make([]Card, 0, len(it.Test))
		for _, card := range it.Test {
			tests = append(tests, fresh(card))
		}
		it.Test = tests
		into.Items.Add(key, it)
	}
	for _, card := range piece.Practice {
		into.Practice = append(into.Practice, fresh(card))
	}
	for _, card := range piece.Context {
		into.Context = append(into.Context, fresh(card))
	}
	seen := map[string]bool{}
	for _, group := range into.Equivalences {
		seen[strings.Join(group, "|")] = true
	}
	for _, group := range piece.Equivalences {
		if !seen[strings.Join(group, "|")] {
			into.Equivalences = append(into.Equivalences, group)
			seen[strings.Join(group, "|")] = true
		}
	}
}
