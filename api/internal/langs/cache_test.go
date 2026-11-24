package langs

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/regyeduardo/study-helper/api/internal/ai"
	"github.com/regyeduardo/study-helper/api/internal/blobs"
)

// Owner, 23/11: every generation is kept in R2, for every account; the same word is never generated again. A reported card is made
// again another way (the other model, with the reason) and the new one replaces the old for everyone.

func TestTheSameWordIsNeverGeneratedAgain(t *testing.T) {
	db := newDB(t)
	cache := &ItemCache{Blobs: blobs.NewMemory()}
	ana, bia := person(t, db, "ana"), person(t, db, "bia")
	for _, user := range []string{ana, bia} {
		_, _ = AddLanguage(db, user, "en", "", "", day)
	}
	first := &fakeAI{answer: func(int, ai.Model, string) (string, error) { return okJSON(t), nil }}
	g := &Generator{DB: db, AI: first, Models: models, Now: func() time.Time { return day }, Cache: cache}
	anaText, _ := AddText(db, ana, "en", "Chuva", "I used to walk to school every day\nBut now I won't walk in the rain", day)
	if err := g.Run(context.Background(), ana, anaText); err != nil {
		t.Fatal(err)
	}
	stored, err := cache.Get(context.Background(), "en", "walk")
	if err != nil || stored.Item.Label != "walk" || stored.Version != 1 || stored.Model != "primeiro" || stored.Item.Test[0].ID != "walk__1" {
		t.Fatalf("kept in R2: %+v %v", stored, err)
	}

	// Bia's text has "walk": the AI is told it is ready and only says it reuses it
	reuse := `{"equivalences": [], "reuse": ["walk"], "items": {"rain": {"area": "lexico", "kind": "word", "label": "rain", "meaning": "chuva",
	  "test": [{"type": "listen_mc", "skill": "listen", "q": "Ouça:", "say": "It is going to rain", "opts": ["vai chover", "choveu", "está chovendo", "não chove", "chove muito"], "a": 0}]}},
	  "practice": [{"id": "p_dict", "type": "dictation", "skill": "listen", "q": "Ouça e escreva:", "say": "I walk in the rain", "covers": ["walk", "rain"]}], "context": []}`
	second := &fakeAI{answer: func(int, ai.Model, string) (string, error) { return reuse, nil }}
	g.AI = second
	biaText, _ := AddText(db, bia, "en", "Na chuva", "I walk in the rain", day)
	if err := g.Run(context.Background(), bia, biaText); err != nil {
		t.Fatal(err)
	}
	// only the ready items whose words are in the piece: walk (and its sense "walk_way"), never "used to"
	if !strings.Contains(second.prompts[0], "walk | walk | word") || strings.Contains(second.prompts[0], "used_to |") {
		t.Fatalf("only the ready items of this piece go to the AI: %s", second.prompts[0])
	}
	out, _, err := TextOut(db, bia, "en", biaText)
	if err != nil || len(out.Items.Keys) != 2 || out.Items.ByID["walk"].Test[0].ID != "walk__1" || out.Items.ByID["walk"].Meaning != "andar, caminhar" {
		t.Fatalf("walk came from R2: %+v %v", out.Items.Keys, err)
	}
	if rain, err := cache.Get(context.Background(), "en", "rain"); err != nil || rain.Item.Test[0].ID != "rain__1" {
		t.Fatalf("the new word is kept too: %+v %v", rain, err)
	}
}

func TestReportMakesTheWordAgainForEveryone(t *testing.T) {
	db := newDB(t)
	cache := &ItemCache{Blobs: blobs.NewMemory()}
	ana, bia := person(t, db, "ana"), person(t, db, "bia")
	texts := map[string]string{}
	g := &Generator{DB: db, AI: &fakeAI{answer: func(int, ai.Model, string) (string, error) { return okJSON(t), nil }}, Models: models, Now: func() time.Time { return day }, Cache: cache}
	for _, user := range []string{ana, bia} {
		_, _ = AddLanguage(db, user, "en", "", "", day)
		texts[user], _ = AddText(db, user, "en", "Chuva", "I walk", day)
		if err := g.Run(context.Background(), user, texts[user]); err != nil {
			t.Fatal(err)
		}
	}
	remade := `{"test": [
	  {"type": "listen_mc", "skill": "listen", "q": "Ouça e escolha o sentido:", "say": "We walk home", "opts": ["andamos para casa", "corremos para casa", "voltamos de carro", "ficamos em casa", "andamos pela casa"], "a": 0},
	  {"type": "mc", "skill": "read", "q": "\"walk\" quer dizer:", "opts": ["correr", "andar", "saltar", "parar", "nadar"], "a": 1}]}`
	fixer := &fakeAI{answer: func(int, ai.Model, string) (string, error) { return remade, nil }}
	g.AI = fixer
	if err := g.ReportNow(context.Background(), ana, "en", texts[ana], "walk__1", "two_right", "duas opções servem"); err != nil {
		t.Fatal(err)
	}
	if fixer.models[0] != "segundo" {
		t.Fatalf("another way: the other model first, got %v", fixer.models)
	}
	prompt := fixer.prompts[0]
	for _, want := range []string{"Duas opções estão certas", "duas opções servem", "Eu ando até a escola", "DIFFERENT"} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("the prompt has %q: %s", want, prompt)
		}
	}
	stored, _ := cache.Get(context.Background(), "en", "walk")
	if stored.Version != 2 || stored.Model != "segundo" || len(stored.Reports) != 1 || stored.Reports[0].Reason != "two_right" {
		t.Fatalf("R2 has the new version and the report: %+v", stored)
	}
	for _, user := range []string{ana, bia} {
		out, _, _ := TextOut(db, user, "en", texts[user])
		tests := out.Items.ByID["walk"].Test
		if len(tests) != 2 || tests[0].Q != "Ouça e escolha o sentido:" || tests[0].ID != "walk__1" {
			t.Fatalf("%s sees the new cards: %+v", user, tests)
		}
	}

	// a card of the text itself is made again only in that text
	card := `{"card": {"type": "dictation", "skill": "listen", "q": "Ouça e escreva a frase:", "say": "I walk to school", "covers": ["walk"]}}`
	g.AI = &fakeAI{answer: func(int, ai.Model, string) (string, error) { return card, nil }}
	if err := g.ReportNow(context.Background(), ana, "en", texts[ana], texts[ana]+".p_order", "confusing", ""); err != nil {
		t.Fatal(err)
	}
	anaOut, _, _ := TextOut(db, ana, "en", texts[ana])
	biaOut, _, _ := TextOut(db, bia, "en", texts[bia])
	if anaOut.Practice[0].ID != texts[ana]+".p_order" || anaOut.Practice[0].Type != "dictation" || biaOut.Practice[0].Type != "order" {
		t.Fatalf("only Ana's text card changed: %+v / %+v", anaOut.Practice[0], biaOut.Practice[0])
	}
	if err := g.ReportNow(context.Background(), ana, "en", texts[ana], "nope", "other", ""); err != ErrNotFound {
		t.Fatalf("unknown card: %v", err)
	}
}
