package langs

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/regyeduardo/study-helper/api/internal/store"
)

// T014 (domain): the languages of an account, each with its own base, and the counts the screens show.

func newDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "estudo.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func person(t *testing.T, db *sql.DB, id string) string {
	t.Helper()
	now := Stamp(time.Now())
	if _, err := db.Exec(`INSERT INTO user (id, email, name, status, app_enabled, created_at, updated_at) VALUES (?, ?, 'Pessoa', 'enabled', 1, ?, ?)`, id, id+"@exemplo.com", now, now); err != nil {
		t.Fatal(err)
	}
	return id
}

var day = time.Date(2026, 11, 23, 12, 0, 0, 0, time.UTC)

func TestLanguagesKnownAndOther(t *testing.T) {
	db := newDB(t)
	ana := person(t, db, "ana")
	english, err := AddLanguage(db, ana, "EN", "", "", day)
	if err != nil || english.Code != "en" || english.Name != "Inglês" || english.Locale != "en-US" {
		t.Fatalf("a known language comes with its name and voice: %+v %v", english, err)
	}
	swedish, err := AddLanguage(db, ana, "sv", "Sueco", "sv-SE", day)
	if err != nil || swedish.Name != "Sueco" || swedish.Locale != "sv-SE" {
		t.Fatalf("other: %+v %v", swedish, err)
	}
	tupi, err := AddLanguage(db, ana, "tpw", "Tupi antigo", "", day)
	if err != nil || tupi.Locale != "tpw" {
		t.Fatalf("an unknown one keeps its code as voice: %+v %v", tupi, err)
	}
	if _, err := AddLanguage(db, ana, "en", "", "", day); !errors.Is(err, ErrLanguageExists) {
		t.Fatalf("twice: %v", err)
	}
	for _, code := range []string{"", "english language", "e", "en_US!", "abcdefghijklm"} {
		if _, err := AddLanguage(db, ana, code, "", "", day); !errors.Is(err, ErrInvalidLanguage) {
			t.Fatalf("%q: %v", code, err)
		}
	}
	if _, err := AddLanguage(db, ana, "xx", "", "", day); !errors.Is(err, ErrInvalidLanguage) {
		t.Fatalf("an unknown code needs a name: %v", err)
	}
	list, err := Languages(db, ana, day)
	if err != nil || len(list) != 3 || list[0].Code != "en" || list[1].Code != "sv" {
		t.Fatalf("list in the order they were made: %+v %v", list, err)
	}
	// another account has its own
	bia := person(t, db, "bia")
	if list, _ := Languages(db, bia, day); len(list) != 0 {
		t.Fatalf("another account sees nothing: %+v", list)
	}
	if _, err := AddLanguage(db, bia, "en", "", "", day); err != nil {
		t.Fatalf("each account has its English: %v", err)
	}
	if _, err := LanguageDetail(db, bia, "sv", day); !errors.Is(err, ErrNotFound) {
		t.Fatalf("not hers: %v", err)
	}
}

func readyText(t *testing.T, db *sql.DB, user, code, title string) string {
	t.Helper()
	id, err := AddText(db, user, code, title, "I used to walk to school every day\n\nBut now I won't walk in the rain\n", day)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile("testdata/ok.json")
	var content Content
	if err := json.Unmarshal(raw, &content); err != nil {
		t.Fatal(err)
	}
	if err := SaveContent(db, user, code, id, content, "modelo-teste", day); err != nil {
		t.Fatal(err)
	}
	return id
}

// US3/AC1: errou um item → o app testa o que ele exige; quando o que ele exige veio de outro texto, o texto traz esse item (e o que ele
// exige, até o fim) com os seus cards de teste, à parte dos itens do texto.
func TestTextBringsWhatItsItemsNeedFromTheBase(t *testing.T) {
	db := newDB(t)
	ana := person(t, db, "ana")
	_, _ = AddLanguage(db, ana, "en", "", "", day)
	readyText(t, db, ana, "en", "Caminhar")
	id, err := AddText(db, ana, "en", "Depois", "I'm gonna walk\n", day)
	if err != nil {
		t.Fatal(err)
	}
	var content Content
	raw := `{"equivalences":[],"items":{"gonna":{"area":"lexico","kind":"spoken_form","label":"gonna","meaning":"vou","needs":["used_to"],"test":[{"id":"gonna_t","type":"mc","skill":"read","q":"gonna =","opts":["vou","fui","ia","irei","era"],"a":0,"covers":["gonna"]}]}},"practice":[],"context":[]}`
	if err := json.Unmarshal([]byte(raw), &content); err != nil {
		t.Fatal(err)
	}
	if err := SaveContent(db, ana, "en", id, content, "modelo-teste", day); err != nil {
		t.Fatal(err)
	}
	text, _, err := TextOut(db, ana, "en", id)
	if err != nil {
		t.Fatal(err)
	}
	if len(text.Items.Keys) != 1 || text.Items.Keys[0] != "gonna" {
		t.Fatalf("the text's own items stay only its own: %v", text.Items.Keys)
	}
	if len(text.Needed.Keys) != 2 || text.Needed.ByID["used_to"].Label == "" || text.Needed.ByID["walk"].Label == "" {
		t.Fatalf("what gonna needs, to the end (used_to → walk): %v", text.Needed.Keys)
	}
	if len(text.Needed.ByID["used_to"].Test) == 0 || len(text.Needed.ByID["walk"].Test) == 0 {
		t.Fatalf("each needed item comes with its test cards: %+v", text.Needed.ByID)
	}
	if got := text.Needed.ByID["used_to"].Needs; len(got) != 1 || got[0] != "walk" {
		t.Fatalf("and with what it needs: %v", got)
	}
}

func TestTextsBecomeTheBase(t *testing.T) {
	db := newDB(t)
	ana := person(t, db, "ana")
	if _, err := AddLanguage(db, ana, "en", "", "", day); err != nil {
		t.Fatal(err)
	}
	if _, err := AddText(db, ana, "en", " ", "texto", day); !errors.Is(err, ErrTitleRequired) {
		t.Fatalf("title: %v", err)
	}
	if _, err := AddText(db, ana, "en", "Sem texto", "  \n ", day); !errors.Is(err, ErrTextRequired) {
		t.Fatalf("text: %v", err)
	}
	big := make([]byte, MaxTextChars+1)
	for n := range big {
		big[n] = 'a'
	}
	if _, err := AddText(db, ana, "en", "Grande", string(big), day); !errors.Is(err, ErrTextTooLarge) {
		t.Fatalf("too large: %v", err)
	}
	if _, err := AddText(db, ana, "fr", "Sem idioma", "texte", day); !errors.Is(err, ErrNotFound) {
		t.Fatalf("language not made: %v", err)
	}

	pending, err := AddText(db, ana, "en", "Gerando", "Hello there", day)
	if err != nil {
		t.Fatal(err)
	}
	if _, status, err := TextOut(db, ana, "en", pending); !errors.Is(err, ErrNotReady) || status.Status != "generating" {
		t.Fatalf("not ready: %v %+v", err, status)
	}

	id := readyText(t, db, ana, "en", "Caminhar")
	out, _, err := TextOut(db, ana, "en", id)
	if err != nil {
		t.Fatal(err)
	}
	if out.Title != "Caminhar" || len(out.Lines) != 2 || out.Lines[1] != "But now I won't walk in the rain" {
		t.Fatalf("the text whole, one line per sentence: %+v", out.Lines)
	}
	if len(out.Items.Keys) != 4 || out.Items.Keys[0] != "walk" || len(out.Items.ByID["walk"].Test) != 2 || len(out.Practice) != 9 || len(out.Context) != 1 {
		t.Fatalf("items and cards back in order: %v %d %d", out.Items.Keys, len(out.Practice), len(out.Context))
	}
	if needs := out.Items.ByID["used_to"].Needs; len(needs) != 1 || needs[0] != "walk" {
		t.Fatalf("needs: %v", needs)
	}
	if card := out.Practice[0]; card.ID != id+".p_order" || card.Answer != "I used to walk" || len(card.Covers) != 1 {
		t.Fatalf("a card comes back as it was: %+v", card)
	}
	if len(out.Equivalences) != 2 || len(out.Facets) != 9 {
		t.Fatalf("equivalences and facets: %v %d", out.Equivalences, len(out.Facets))
	}

	detail, err := LanguageDetail(db, ana, "en", day)
	if err != nil {
		t.Fatal(err)
	}
	if detail.Items != 4 || detail.Seen != 0 || len(detail.Texts) != 2 || detail.Areas["gramatica"].Total != 2 || detail.Areas["lexico"].Total != 1 {
		t.Fatalf("counts: %+v", detail)
	}
	if detail.Texts[1].ID != id || detail.Texts[1].Status != "ready" || detail.Texts[1].Progress != "start" || detail.Texts[0].Status != "generating" {
		t.Fatalf("texts: %+v", detail.Texts)
	}

	// a second text with the same items does not double the base
	second := readyText(t, db, ana, "en", "De novo")
	if detail, _ := LanguageDetail(db, ana, "en", day); detail.Items != 4 {
		t.Fatalf("the same item twice is one: %d", detail.Items)
	}
	// deleting a text keeps the base
	if err := DeleteText(db, ana, "en", second); err != nil {
		t.Fatal(err)
	}
	if detail, _ := LanguageDetail(db, ana, "en", day); detail.Items != 4 || len(detail.Texts) != 2 {
		t.Fatalf("after delete: %+v", detail)
	}
	if err := DeleteText(db, ana, "en", second); !errors.Is(err, ErrNotFound) {
		t.Fatalf("gone: %v", err)
	}
}

func TestFailedTextAndRetry(t *testing.T) {
	db := newDB(t)
	ana := person(t, db, "ana")
	_, _ = AddLanguage(db, ana, "en", "", "", day)
	id, _ := AddText(db, ana, "en", "Falha", "Hello", day)
	if err := Retry(db, ana, "en", id); !errors.Is(err, ErrNotFailed) {
		t.Fatalf("only a failed one: %v", err)
	}
	if err := FailText(db, ana, id, "provider_down"); err != nil {
		t.Fatal(err)
	}
	if _, status, err := TextOut(db, ana, "en", id); !errors.Is(err, ErrNotReady) || status.Status != "failed" || status.Error != "provider_down" {
		t.Fatalf("failed: %+v %v", status, err)
	}
	if err := Retry(db, ana, "en", id); err != nil {
		t.Fatal(err)
	}
	if _, status, _ := TextOut(db, ana, "en", id); status.Status != "generating" || status.Error != "" {
		t.Fatalf("retry: %+v", status)
	}
}

// schedule is a card's FSRS state as the app sends it (src/lib/langs/fsrs.ts).
func schedule(state string, days int, due time.Time) *Schedule {
	at, last := Stamp(due), Stamp(day)
	return &Schedule{State: state, Stability: 2.3, Difficulty: 5, DueAt: &at, LastReviewAt: &last, ScheduledDays: days, Reps: 1}
}

// T116/T117 (spec 004, 24/11: "é por card"): each answer keeps its FSRS rating and the card's schedule the app computed; the item's
// state in each skill comes from the cards that train it.
func TestAnswersBuildTheKnowledge(t *testing.T) {
	db := newDB(t)
	ana := person(t, db, "ana")
	_, _ = AddLanguage(db, ana, "en", "", "", day)
	id := readyText(t, db, ana, "en", "Caminhar")
	yes, no := true, false
	card := func(name string) string { return id + "." + name } // practice cards are the text's: its id in front
	// a listening card answered right and out of the short steps: "listen" of what it covers, not due
	if err := RecordAnswer(db, ana, "en", Answer{TextID: id, CardID: card("p_mp"), Stage: "practice", PromptLang: "native", Answer: "walk", OK: &yes, Schedule: schedule("review", 2, day.Add(48*time.Hour))}, day); err != nil {
		t.Fatal(err)
	}
	knowledge, err := Knowledge(db, ana, "en", day)
	if err != nil || knowledge["walk"]["listen"] != "learning" || knowledge["walk"]["recognize"] != nil || knowledge["walk"]["due"] != false {
		t.Fatalf("listen: %+v %v", knowledge, err)
	}
	// wrong: the card is learning again (short steps), so the items it covers are due
	if err := RecordAnswer(db, ana, "en", Answer{TextID: id, CardID: "t_wont_dict", Stage: "test", PromptLang: "native", Answer: "I want walk", OK: &no, Schedule: schedule("relearning", 0, day.Add(10*time.Minute))}, day); err != nil {
		t.Fatal(err)
	}
	knowledge, _ = Knowledge(db, ana, "en", day.Add(time.Minute))
	if knowledge["neg_will"]["listen"] != "learning" || knowledge["neg_will"]["due"] != true || knowledge["walk"]["due"] != true {
		t.Fatalf("wrong is due: %+v", knowledge)
	}
	// skipped (ok null) only records: no rating, no schedule
	if err := RecordAnswer(db, ana, "en", Answer{TextID: id, CardID: card("p_speak"), Stage: "practice", PromptLang: "native", Schedule: schedule("review", 3, day)}, day); err != nil {
		t.Fatal(err)
	}
	knowledge, _ = Knowledge(db, ana, "en", day)
	if _, ok := knowledge["neg_will"]["speak"]; ok {
		t.Fatalf("skipped does not count: %+v", knowledge["neg_will"])
	}
	// the order card trains "produce"; right only after the learn card is Hard
	_ = RecordAnswer(db, ana, "en", Answer{TextID: id, CardID: card("p_order"), Stage: "practice", PromptLang: "native", Answer: "I used to walk", OK: &yes, Retry: true, Schedule: schedule("review", 1, day.Add(24*time.Hour))}, day)
	knowledge, _ = Knowledge(db, ana, "en", day)
	if knowledge["used_to"]["produce"] != "learning" {
		t.Fatalf("produce: %+v", knowledge["used_to"])
	}
	ratings := []int{}
	rows, _ := db.Query(`SELECT COALESCE(rating, 0) FROM lang_answers WHERE user_id = ? AND language = 'en' ORDER BY id`, ana)
	for rows.Next() {
		var r int
		_ = rows.Scan(&r)
		ratings = append(ratings, r)
	}
	rows.Close()
	if fmt.Sprint(ratings) != "[3 1 0 2]" {
		t.Fatalf("ratings Good, Again, skipped, Hard: %v", ratings)
	}
	if err := RecordAnswer(db, ana, "en", Answer{TextID: id, CardID: "nope", Stage: "practice", PromptLang: "native", OK: &yes}, day); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown card: %v", err)
	}
	if err := RecordAnswer(db, ana, "en", Answer{TextID: id, CardID: card("p_mp"), Stage: "nowhere", PromptLang: "native", OK: &yes}, day); !errors.Is(err, ErrInvalidAnswer) {
		t.Fatalf("bad stage: %v", err)
	}
	if err := RecordAnswer(db, ana, "en", Answer{TextID: id, CardID: card("p_mp"), Stage: "practice", PromptLang: "native", OK: &yes, Schedule: schedule("done", 0, day)}, day); !errors.Is(err, ErrInvalidAnswer) {
		t.Fatalf("bad schedule: %v", err)
	}
	detail, _ := LanguageDetail(db, ana, "en", day.Add(time.Minute))
	// the dictation wrong covers neg_will and walk: both due
	if detail.Seen != 3 || detail.Due != 2 || detail.Areas["lexico"].Seen != 1 {
		t.Fatalf("seen and due: %+v", detail)
	}
	// of the 4 items, only used_to is proven with no review due: 25% of the text known (FR-038)
	if detail.Texts[0].Known != 25 {
		t.Fatalf("known: %d", detail.Texts[0].Known)
	}
}

// FR-029, FR-030, FR-031, FR-040: fixed when every card answered is 21+ days; a fixed item still has its reviews; deleting the text
// keeps the base; "ouve e fala" after 2 different listening cards and 2 speaking ones, on different days.
func TestCardsScheduleTheBase(t *testing.T) {
	db := newDB(t)
	ana := person(t, db, "ana")
	_, _ = AddLanguage(db, ana, "en", "", "", day)
	id := readyText(t, db, ana, "en", "Caminhar")
	yes := true
	answer := func(card string, s *Schedule, at time.Time) {
		t.Helper()
		if err := RecordAnswer(db, ana, "en", Answer{TextID: id, CardID: card, Stage: "practice", PromptLang: "native", OK: &yes, Schedule: s}, at); err != nil {
			t.Fatal(err)
		}
	}
	answer(id+".p_mp", schedule("review", 25, day.Add(25*24*time.Hour)), day)
	answer(id+".p_sd", schedule("review", 7, day.Add(7*24*time.Hour)), day)
	knowledge, _ := Knowledge(db, ana, "en", day)
	if knowledge["walk"]["listen"] != "learning" {
		t.Fatalf("one listening card under 21 days: not fixed yet: %+v", knowledge["walk"])
	}
	answer(id+".p_sd", schedule("review", 30, day.Add(37*24*time.Hour)), day.Add(7*24*time.Hour))
	knowledge, _ = Knowledge(db, ana, "en", day.Add(8*24*time.Hour))
	if knowledge["walk"]["listen"] != "fixed" || knowledge["walk"]["due"] != false {
		t.Fatalf("every listening card 21+ days: fixed: %+v", knowledge["walk"])
	}
	later := day.Add(40 * 24 * time.Hour)
	knowledge, _ = Knowledge(db, ana, "en", later)
	if knowledge["walk"]["due"] != true || knowledge["walk"]["listen"] != "fixed" {
		t.Fatalf("a fixed item with a review due is due: %+v", knowledge["walk"])
	}
	langs, _ := Languages(db, ana, later)
	if len(langs) != 1 || langs[0].Due < 1 || langs[0].Fixed != 1 {
		t.Fatalf("the language counts the fixed item due for review: %+v", langs)
	}
	// "ouve e fala": 2 listening cards on 2 days are there; 2 speaking cards on 2 days complete it
	if knowledge["walk"]["hearsAndSpeaks"] != nil {
		t.Fatal("no speaking yet")
	}
	for _, s := range []string{"s1", "s2"} {
		if _, err := db.Exec(`INSERT INTO lang_cards (user_id, language, id, type, skill, data, created_at) VALUES (?, 'en', ?, 'speak', 'speak', '{}', ?)`, ana, s, Stamp(day)); err != nil {
			t.Fatal(err)
		}
		_, _ = db.Exec(`INSERT INTO lang_card_items (user_id, language, card_id, item_id, role) VALUES (?, 'en', ?, 'walk', 'covers')`, ana, s)
	}
	answer("s1", schedule("review", 3, day.Add(3*24*time.Hour)), day)
	answer("s1", schedule("review", 9, day.Add(12*24*time.Hour)), day.Add(3*24*time.Hour))
	if k, _ := Knowledge(db, ana, "en", later); k["walk"]["hearsAndSpeaks"] != nil {
		t.Fatal("the same speaking card twice is one situation")
	}
	answer("s2", schedule("review", 3, day.Add(6*24*time.Hour)), day.Add(3*24*time.Hour))
	if k, _ := Knowledge(db, ana, "en", later); k["walk"]["hearsAndSpeaks"] != true {
		t.Fatalf("2 listening + 2 speaking cards, on different days: %+v", k["walk"])
	}
	// deleting the text keeps cards, schedules and answers: the base stays
	if err := DeleteText(db, ana, "en", id); err != nil {
		t.Fatal(err)
	}
	if k, _ := Knowledge(db, ana, "en", later); k["walk"]["listen"] != "fixed" || k["walk"]["hearsAndSpeaks"] != true {
		t.Fatalf("after deleting the text: %+v", k["walk"])
	}
}

func TestProgress(t *testing.T) {
	db := newDB(t)
	ana := person(t, db, "ana")
	_, _ = AddLanguage(db, ana, "en", "", "", day)
	id := readyText(t, db, ana, "en", "Caminhar")
	if _, _, err := Progress(db, ana, "en", id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("none yet: %v", err)
	}
	if err := SaveProgress(db, ana, "en", id, json.RawMessage(`{"part":"practice","at":3}`), day); err != nil {
		t.Fatal(err)
	}
	state, _, err := Progress(db, ana, "en", id)
	if err != nil || string(state) != `{"part":"practice","at":3}` {
		t.Fatalf("progress: %s %v", state, err)
	}
	if detail, _ := LanguageDetail(db, ana, "en", day); detail.Texts[0].Progress != "continue" {
		t.Fatalf("continue: %+v", detail.Texts)
	}
	_ = SaveProgress(db, ana, "en", id, json.RawMessage(`{"done":true}`), day)
	if detail, _ := LanguageDetail(db, ana, "en", day); detail.Texts[0].Progress != "done" {
		t.Fatalf("done: %+v", detail.Texts)
	}
	if err := SaveProgress(db, ana, "en", id, json.RawMessage(`nope`), day); !errors.Is(err, ErrInvalidAnswer) {
		t.Fatalf("bad state: %v", err)
	}
	if err := SaveProgress(db, ana, "en", "outro", json.RawMessage(`{}`), day); !errors.Is(err, ErrNotFound) {
		t.Fatalf("no text: %v", err)
	}
}
