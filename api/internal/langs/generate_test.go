package langs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/regyeduardo/study-helper/api/internal/ai"
)

// T023: the generation, with a fake AI. The text is sent whole; inside, the AI is called in pieces and the pieces become one text.

type fakeAI struct {
	mu      sync.Mutex
	prompts []string
	models  []string
	answer  func(n int, model ai.Model, prompt string) (string, error)
}

func (f *fakeAI) Chat(_ context.Context, model ai.Model, prompt string, asJSON bool) (string, error) {
	f.mu.Lock()
	n := len(f.prompts)
	f.prompts = append(f.prompts, prompt)
	f.models = append(f.models, model.ID)
	f.mu.Unlock()
	if !asJSON {
		return "", errors.New("the generation asks for JSON")
	}
	return f.answer(n, model, prompt)
}

func okJSON(t *testing.T) string {
	t.Helper()
	raw, err := os.ReadFile("testdata/ok.json")
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

var models = []ai.Model{{Provider: "deepinfra", ID: "primeiro"}, {Provider: "openrouter", ID: "segundo"}}

func generator(db any, fake *fakeAI) *Generator {
	return &Generator{AI: fake, Models: models, Now: func() time.Time { return day }, ChunkLines: 10}
}

func TestGenerateMakesTheTextReady(t *testing.T) {
	db := newDB(t)
	ana := person(t, db, "ana")
	_, _ = AddLanguage(db, ana, "en", "", "", day)
	_, _ = AddLanguage(db, ana, "es", "", "", day)
	// the Spanish base never goes to an English text
	spanish, _ := AddText(db, ana, "es", "Hola", "Hola amigo", day)
	_ = SaveContent(db, ana, "es", spanish, mustContent(t, strings.ReplaceAll(okJSON(t), `"walk_way"`, `"hola_saludo"`)), "m", day)
	english, _ := AddText(db, ana, "en", "Antes", "I walk", day)
	_ = SaveContent(db, ana, "en", english, mustContent(t, okJSON(t)), "m", day)

	id, _ := AddText(db, ana, "en", "Chuva", "I used to walk to school every day\nBut now I won't walk in the rain", day)
	fake := &fakeAI{answer: func(int, ai.Model, string) (string, error) { return okJSON(t), nil }}
	g := generator(db, fake)
	g.DB = db
	if err := g.Run(context.Background(), ana, id); err != nil {
		t.Fatal(err)
	}
	out, _, err := TextOut(db, ana, "en", id)
	if err != nil || len(out.Items.Keys) != 4 || len(out.Lines) != 2 {
		t.Fatalf("ready: %v %+v", err, out.Items.Keys)
	}
	prompt := fake.prompts[0]
	for _, want := range []string{"neg_will", "used_to", "I used to walk to school every day", "But now I won't walk in the rain", "Inglês"} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("the prompt has %q (the base to reuse and the text): %s", want, prompt[:min(len(prompt), 400)])
		}
	}
	if strings.Contains(prompt, "hola_saludo") {
		t.Fatal("the Spanish base went to the English text")
	}
	var model string
	_ = db.QueryRow(`SELECT model FROM lang_texts WHERE id = ?`, id).Scan(&model)
	if model != "primeiro" {
		t.Fatalf("model kept: %q", model)
	}
}

func mustContent(t *testing.T, raw string) Content {
	t.Helper()
	var c Content
	if err := json.Unmarshal([]byte(raw), &c); err != nil {
		t.Fatal(err)
	}
	return c
}

func TestGeneratePromptRules(t *testing.T) {
	prompt := Prompt("Inglês", "en", []string{"Hello"}, nil, nil, 1, 1)
	for _, want := range []string{"exactly 5 options", "distractors", "never", "rhyme", "verse", "chorus", "Portuguese", "formIsTopic", "JSON"} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("the prompt says %q", want)
		}
	}
}

func TestGenerateBigTextInPiecesIsOneText(t *testing.T) {
	db := newDB(t)
	ana := person(t, db, "ana")
	_, _ = AddLanguage(db, ana, "en", "", "", day)
	lines := []string{}
	for n := 0; n < 25; n++ {
		lines = append(lines, fmt.Sprintf("Line number %d of the song", n))
	}
	id, _ := AddText(db, ana, "en", "Longa", strings.Join(lines, "\n"), day)
	fake := &fakeAI{answer: func(n int, _ ai.Model, _ string) (string, error) {
		// every piece brings the same items (as a song repeats) and one of its own
		own := fmt.Sprintf(`"piece_%d": {"area": "lexico", "kind": "word", "label": "p%d", "meaning": "pedaço", "test": [{"id": "t_piece_%d", "type": "tf", "skill": "read", "q": "Verdade?", "a": true}]},`, n, n, n)
		return strings.Replace(okJSON(t), `"items": {`, `"items": {`+own, 1), nil
	}}
	g := generator(db, fake)
	g.DB = db
	if err := g.Run(context.Background(), ana, id); err != nil {
		t.Fatal(err)
	}
	if len(fake.prompts) != 3 {
		t.Fatalf("25 lines in pieces of 10: 3 calls, got %d", len(fake.prompts))
	}
	if !strings.Contains(fake.prompts[1], "piece_0") || !strings.Contains(fake.prompts[2], "piece_1") {
		t.Fatal("each piece knows the items of the pieces before")
	}
	if !strings.Contains(fake.prompts[1], "Line number 10 of the song") || strings.Contains(fake.prompts[1], "Line number 9 of the song\n") {
		t.Fatal("each piece gets its own lines")
	}
	out, _, err := TextOut(db, ana, "en", id)
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Lines) != 25 {
		t.Fatalf("the text stays whole: %d lines", len(out.Lines))
	}
	if len(out.Items.Keys) != 7 {
		t.Fatalf("4 shared + 3 own, no item twice: %v", out.Items.Keys)
	}
	// every piece brings the same 9 practice cards (same kind, items and sentence): the same card is one (FR-039, 24/11)
	if len(out.Practice) != 9 {
		t.Fatalf("the practice of every piece, each card once: %d", len(out.Practice))
	}
	ids := map[string]bool{}
	all := append(append([]Card{}, out.Practice...), out.Context...)
	for _, key := range out.Items.Keys {
		all = append(all, out.Items.ByID[key].Test...)
	}
	for _, card := range all {
		if ids[card.ID] {
			t.Fatalf("card id twice: %s", card.ID)
		}
		ids[card.ID] = true
	}
	var count int
	_ = db.QueryRow(`SELECT COUNT(*) FROM lang_texts WHERE user_id = ?`, ana).Scan(&count)
	if count != 1 {
		t.Fatalf("one text: %d", count)
	}
}

func TestGenerateSendsTheProblemsBack(t *testing.T) {
	db := newDB(t)
	ana := person(t, db, "ana")
	_, _ = AddLanguage(db, ana, "en", "", "", day)
	id, _ := AddText(db, ana, "en", "Erro", "I walk", day)
	// nothing usable: every item without a valid test card (a bad card alone is dropped, not sent back)
	bad := strings.ReplaceAll(okJSON(t), `"skill": "read"`, `"skill": "speak"`)
	bad = strings.ReplaceAll(bad, `"skill": "listen"`, `"skill": "speak"`)
	fake := &fakeAI{answer: func(n int, _ ai.Model, _ string) (string, error) {
		if n == 0 {
			return bad, nil
		}
		if n == 1 {
			return "isto não é json", nil
		}
		return okJSON(t), nil
	}}
	g := generator(db, fake)
	g.DB = db
	if err := g.Run(context.Background(), ana, id); err != nil {
		t.Fatal(err)
	}
	if len(fake.prompts) != 3 || !strings.Contains(fake.prompts[1], "no valid item") || !strings.Contains(fake.prompts[1], bad[:40]) {
		t.Fatalf("the problems go back with the answer: %d calls", len(fake.prompts))
	}
	if _, status, err := TextOut(db, ana, "en", id); err != nil || status.Status != "ready" {
		t.Fatalf("fixed: %v %+v", err, status)
	}

	// still wrong after 2 more tries: failed with the reason
	other, _ := AddText(db, ana, "en", "Sempre errado", "I walk", day)
	always := &fakeAI{answer: func(int, ai.Model, string) (string, error) { return bad, nil }}
	g = generator(db, always)
	g.DB = db
	if err := g.Run(context.Background(), ana, other); err == nil {
		t.Fatal("it never got right")
	}
	if len(always.prompts) != 3 {
		t.Fatalf("1 + 2 tries: %d", len(always.prompts))
	}
	if _, status, _ := TextOut(db, ana, "en", other); status.Status != "failed" || status.Error != "invalid_content" {
		t.Fatalf("failed: %+v", status)
	}
}

func TestGenerateTriesTheNextModel(t *testing.T) {
	db := newDB(t)
	ana := person(t, db, "ana")
	_, _ = AddLanguage(db, ana, "en", "", "", day)
	id, _ := AddText(db, ana, "en", "Queda", "I walk", day)
	fake := &fakeAI{answer: func(_ int, model ai.Model, _ string) (string, error) {
		if model.ID == "primeiro" {
			return "", ai.ErrProviderDown
		}
		return okJSON(t), nil
	}}
	g := generator(db, fake)
	g.DB = db
	if err := g.Run(context.Background(), ana, id); err != nil {
		t.Fatal(err)
	}
	var model string
	_ = db.QueryRow(`SELECT model FROM lang_texts WHERE id = ?`, id).Scan(&model)
	if model != "segundo" {
		t.Fatalf("the second model made it: %q", model)
	}

	down, _ := AddText(db, ana, "en", "Tudo fora", "I walk", day)
	all := &fakeAI{answer: func(int, ai.Model, string) (string, error) { return "", ai.ErrProviderDown }}
	g = generator(db, all)
	g.DB = db
	_ = g.Run(context.Background(), ana, down)
	if _, status, _ := TextOut(db, ana, "en", down); status.Status != "failed" || status.Error != "provider_down" {
		t.Fatalf("every model down: %+v", status)
	}
}

func TestQueueOneAtATimePerAccount(t *testing.T) {
	db := newDB(t)
	ana := person(t, db, "ana")
	_, _ = AddLanguage(db, ana, "en", "", "", day)
	var mu sync.Mutex
	running, most := 0, 0
	fake := &fakeAI{answer: func(int, ai.Model, string) (string, error) {
		mu.Lock()
		running++
		if running > most {
			most = running
		}
		mu.Unlock()
		time.Sleep(20 * time.Millisecond)
		mu.Lock()
		running--
		mu.Unlock()
		return okJSON(t), nil
	}}
	g := generator(db, fake)
	g.DB = db
	ids := []string{}
	for n := 0; n < 3; n++ {
		id, _ := AddText(db, ana, "en", fmt.Sprintf("T%d", n), "I walk", day)
		ids = append(ids, id)
		g.Enqueue(ana, id)
	}
	g.Wait()
	if most != 1 {
		t.Fatalf("one at a time for the account: %d", most)
	}
	for _, id := range ids {
		if _, status, err := TextOut(db, ana, "en", id); err != nil {
			t.Fatalf("%s: %+v %v", id, status, err)
		}
	}
}

// Constituição IV (24/11, "estou igual trouxa esperando sem saber o que está acontecendo"): enquanto gera, o texto diz quantas partes
// já saíram de quantas, quando começou, quando saiu a última e por volta de quando termina; ao terminar, some.
func TestGenerationTellsHowFarItIs(t *testing.T) {
	db := newDB(t)
	ana := person(t, db, "ana")
	_, _ = AddLanguage(db, ana, "en", "", "", day)
	lines := []string{}
	for n := 0; n < 25; n++ {
		lines = append(lines, fmt.Sprintf("Line number %d of the song", n))
	}
	id, _ := AddText(db, ana, "en", "Longa", strings.Join(lines, "\n"), day)
	clock := day
	var g *Generator
	seen := []GenProgress{}
	fake := &fakeAI{answer: func(n int, _ ai.Model, _ string) (string, error) {
		if p := g.ProgressOf(id); p != nil {
			seen = append(seen, *p)
		}
		clock = clock.Add(2 * time.Minute) // each piece takes 2 minutes
		return okJSON(t), nil
	}}
	g = generator(db, fake)
	g.DB = db
	g.Now = func() time.Time { return clock }
	if g.ProgressOf(id) != nil {
		t.Fatal("nothing before it starts")
	}
	if err := g.Run(context.Background(), ana, id); err != nil {
		t.Fatal(err)
	}
	if len(seen) != 3 {
		t.Fatalf("one look per piece: %d", len(seen))
	}
	if seen[0].Done != 0 || seen[0].Total != 3 || seen[0].StartedAt != Stamp(day) || seen[0].EndsAt != "" {
		t.Fatalf("first piece: 0 of 3, started, no end guess yet: %+v", seen[0])
	}
	// after the first piece (2 min): 1 of 3, the last at 2 min, ends around 2 more pieces of 2 min
	if seen[1].Done != 1 || seen[1].LastAt != Stamp(day.Add(2*time.Minute)) || seen[1].EndsAt != Stamp(day.Add(6*time.Minute)) {
		t.Fatalf("second piece: %+v", seen[1])
	}
	if seen[2].Done != 2 {
		t.Fatalf("third piece: %+v", seen[2])
	}
	if g.ProgressOf(id) != nil {
		t.Fatal("gone when it ends")
	}
}
