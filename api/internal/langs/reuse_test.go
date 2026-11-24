package langs

import (
	"testing"
	"time"
)

// T114 (spec 004, FR-039, FR-040; owner, 24/11: "Cards podem ser aproveitados se tiver o mesmo significado e/ou mesmo contexto"):
// a second text with the same item (same meaning) or the same sentence (same context) uses the card the language already has, with
// its schedule; a context card is only its text's; deleting the first text keeps the card for the second.
func TestCardsAreReusedAcrossTexts(t *testing.T) {
	db := newDB(t)
	ana := person(t, db, "ana")
	_, _ = AddLanguage(db, ana, "en", "", "", day)
	first := readyText(t, db, ana, "en", "Música A")
	yes := true
	if err := RecordAnswer(db, ana, "en", Answer{TextID: first, CardID: first + ".p_mp", Stage: "practice", PromptLang: "native", OK: &yes, Schedule: schedule("review", 3, day.Add(72*time.Hour))}, day); err != nil {
		t.Fatal(err)
	}
	if err := RecordAnswer(db, ana, "en", Answer{TextID: first, CardID: "t_walk_mc", Stage: "test", PromptLang: "native", OK: &yes, Schedule: schedule("review", 2, day.Add(48*time.Hour))}, day); err != nil {
		t.Fatal(err)
	}

	second := readyText(t, db, ana, "en", "Texto B")
	out, _, err := TextOut(db, ana, "en", second)
	if err != nil {
		t.Fatal(err)
	}
	ids := map[string]bool{}
	for _, card := range out.Practice {
		ids[card.ID] = true
	}
	if !ids[first+".p_mp"] || ids[second+".p_mp"] {
		t.Fatalf("the same sentence is the first text's card: %v", ids)
	}
	if out.Items.ByID["walk"].Test[0].ID != "t_walk_mc" {
		t.Fatalf("the same item's test card is one card: %+v", out.Items.ByID["walk"].Test)
	}
	if s, ok := out.Schedules[first+".p_mp"]; !ok || s.ScheduledDays != 3 {
		t.Fatalf("the reused card comes with its schedule: %+v", out.Schedules)
	}
	if s, ok := out.Schedules["t_walk_mc"]; !ok || s.ScheduledDays != 2 {
		t.Fatalf("the test card comes with its schedule: %+v", out.Schedules)
	}
	if len(out.Context) != 1 || out.Context[0].ID != second+".c_lit" {
		t.Fatalf("a context card is only its text's: %+v", out.Context)
	}
	var cards int
	_ = db.QueryRow(`SELECT COUNT(*) FROM lang_cards WHERE user_id = ? AND language = 'en'`, ana).Scan(&cards)
	// 5 test + 9 practice + 2 context (one per text)
	if cards != 16 {
		t.Fatalf("cards of the language: %d", cards)
	}

	// the first text goes: the second keeps the card and its schedule
	if err := DeleteText(db, ana, "en", first); err != nil {
		t.Fatal(err)
	}
	out, _, _ = TextOut(db, ana, "en", second)
	if s, ok := out.Schedules[first+".p_mp"]; !ok || s.ScheduledDays != 3 || len(out.Practice) != 9 {
		t.Fatalf("after deleting the first text: %d cards, %+v", len(out.Practice), out.Schedules)
	}
}

// A practice card from before 24/11 has no key: the next text of the language gives it one and reuses it.
func TestOldCardsGetTheirKey(t *testing.T) {
	db := newDB(t)
	ana := person(t, db, "ana")
	_, _ = AddLanguage(db, ana, "en", "", "", day)
	first := readyText(t, db, ana, "en", "Antes")
	if _, err := db.Exec(`UPDATE lang_cards SET reuse_key = NULL WHERE user_id = ?`, ana); err != nil {
		t.Fatal(err)
	}
	second := readyText(t, db, ana, "en", "Depois")
	out, _, _ := TextOut(db, ana, "en", second)
	for _, card := range out.Practice {
		if card.ID[:len(first)] != first {
			t.Fatalf("the old card is reused: %s", card.ID)
		}
	}
}
