package langs

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// T012: the validator of the generated format. A text is only ready when it passes; what fails goes back to the AI to fix.

func loadOK(t *testing.T) Content {
	t.Helper()
	raw, err := os.ReadFile("testdata/ok.json")
	if err != nil {
		t.Fatal(err)
	}
	var content Content
	if err := json.Unmarshal(raw, &content); err != nil {
		t.Fatal(err)
	}
	return content
}

func card(c *Content, id string) *Card {
	for _, list := range [][]Card{c.Practice, c.Context} {
		for n := range list {
			if list[n].ID == id {
				return &list[n]
			}
		}
	}
	for _, key := range c.Items.Keys {
		item := c.Items.ByID[key]
		for n := range item.Test {
			if item.Test[n].ID == id {
				return &item.Test[n]
			}
		}
	}
	return nil
}

func item(c *Content, id string, change func(*Item)) {
	value := c.Items.ByID[id]
	change(&value)
	c.Items.ByID[id] = value
}

func TestValidateAcceptsAGoodText(t *testing.T) {
	content := loadOK(t)
	if problems := Validate(content, nil); len(problems) != 0 {
		t.Fatalf("a good text has problems: %v", problems)
	}
	if strings.Join(content.Items.Keys, ",") != "walk,used_to,walk_way,neg_will" {
		t.Fatalf("the items lost their order: %v", content.Items.Keys)
	}
}

func TestValidateFindsEachProblem(t *testing.T) {
	cases := []struct {
		name   string
		change func(*Content)
		want   string
	}{
		{"repeated card id", func(c *Content) { card(c, "p_match").ID = "p_order" }, "card id p_order repeated"},
		{"bad item id", func(c *Content) {
			c.Items.Add("Walk Up", Item{Area: "lexico", Kind: "word", Label: "x", Meaning: "y", Test: []Card{{ID: "t_x", Type: "tf", Skill: "read", Q: "q", A: json.RawMessage("true")}}})
		}, "item id \"Walk Up\""},
		{"needs unknown item", func(c *Content) { item(c, "used_to", func(i *Item) { i.Needs = []string{"nowhere"} }) }, "needs nowhere"},
		{"needs in a cycle", func(c *Content) { item(c, "walk", func(i *Item) { i.Needs = []string{"used_to"} }) }, "cycle"},
		{"answer outside the options", func(c *Content) { card(c, "t_walk_mc").A = json.RawMessage("5") }, "t_walk_mc: a"},
		{"four options", func(c *Content) { card(c, "t_used_gap").Opts = []string{"a", "b", "c", "used to"} }, "t_used_gap: 5 options"},
		{"two equivalent options", func(c *Content) {
			card(c, "c_lit").Opts = []string{"won't", "will not", "de carro", "de bicicleta", "de trem"}
		}, "c_lit: equivalent options"},
		{"find_diff points at a word that did not change", func(c *Content) { card(c, "p_fd").A = json.RawMessage("2") }, "p_fd"},
		{"find_diff with two changes", func(c *Content) { card(c, "p_fd").Say = json.RawMessage(`"We used to run to school"`) }, "p_fd"},
		{"order pieces do not make the answer", func(c *Content) { card(c, "p_order").Tokens = []string{"I", "used", "to", "run"} }, "p_order"},
		{"gap without the blank", func(c *Content) { card(c, "t_used_gap").Text = "I used to walk." }, "t_used_gap: text must have exactly one ___"},
		{"dictation gap count", func(c *Content) { card(c, "p_dgap").Answers = []Accepted{{"used to"}} }, "p_dgap: 2 blanks"},
		{"dictation gap does not rebuild the sentence", func(c *Content) { card(c, "p_dgap").Answers = []Accepted{{"used to"}, {"work"}} }, "p_dgap: the blanks"},
		{"sense without pattern", func(c *Content) { item(c, "walk_way", func(i *Item) { i.Pattern = "" }) }, "walk_way: a sense needs word, pattern and core"},
		{"sense without core", func(c *Content) { item(c, "walk_way", func(i *Item) { i.Core = "" }) }, "walk_way: a sense"},
		{"item without a test card", func(c *Content) { item(c, "neg_will", func(i *Item) { i.Test = nil }) }, "neg_will: no test card"},
		{"card covers an unknown item", func(c *Content) { card(c, "p_odd").Covers = []string{"ghost"} }, "p_odd: covers ghost"},
		{"listen card read skill", func(c *Content) { card(c, "p_mp").Skill = "read" }, "p_mp: skill"},
		{"unknown type", func(c *Content) { card(c, "p_odd").Type = "essay" }, "p_odd: type essay"},
		{"unknown area", func(c *Content) { item(c, "walk", func(i *Item) { i.Area = "literatura" }) }, "walk: area"},
		{"same_diff that lies", func(c *Content) { card(c, "p_sd").A = json.RawMessage(`"same"`) }, "p_sd"},
		{"stress outside the syllables", func(c *Content) { card(c, "p_stress").A = json.RawMessage("2") }, "p_stress"},
		{"stress syllables not the word", func(c *Content) { card(c, "p_stress").Syllables = []string{"to", "night"} }, "p_stress"},
		{"tf without a bool", func(c *Content) { card(c, "t_way_tf").A = json.RawMessage("1") }, "t_way_tf"},
		{"minimal pair of the same word", func(c *Content) { card(c, "p_mp").Pair = []string{"walk", "walk"} }, "p_mp"},
		{"match with one pair", func(c *Content) { card(c, "p_match").Pairs = [][]string{{"walk", "andar"}} }, "p_match"},
		{"context without dp", func(c *Content) { card(c, "c_lit").DP = "" }, "c_lit: dp"},
		{"speak without target", func(c *Content) { card(c, "p_speak").Target = "" }, "p_speak: target"},
		{"listen_mc without the sentence", func(c *Content) { card(c, "t_walk_listen").Say = nil }, "t_walk_listen: say"},
		{"group of one form", func(c *Content) { c.Equivalences = append(c.Equivalences, []string{"gonna"}) }, "a group needs 2 forms"},
		{"empty question", func(c *Content) { card(c, "p_odd").Q = " " }, "p_odd: q"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			content := loadOK(t)
			tc.change(&content)
			problems := Validate(content, nil)
			if !strings.Contains(strings.Join(problems, "\n"), tc.want) {
				t.Fatalf("want a problem with %q, got %v", tc.want, problems)
			}
		})
	}
}

func TestValidateKnowsTheBase(t *testing.T) {
	content := loadOK(t)
	item(&content, "used_to", func(i *Item) { i.Needs = []string{"walk", "be"} })
	if problems := Validate(content, nil); len(problems) == 0 {
		t.Fatal("needs of an item nowhere passed")
	}
	if problems := Validate(content, map[string][]string{"be": nil}); len(problems) != 0 {
		t.Fatalf("an item already in the base is known: %v", problems)
	}
	// a cycle through the base is a cycle too
	if problems := Validate(content, map[string][]string{"be": {"used_to"}}); !strings.Contains(strings.Join(problems, " "), "cycle") {
		t.Fatalf("a cycle through the base passed: %v", problems)
	}
}

func TestValidateFormIsTopicAllowsEquivalentOptions(t *testing.T) {
	content := loadOK(t)
	lit := card(&content, "c_lit")
	lit.Opts = []string{"won't", "will not", "de carro", "de bicicleta", "de trem"}
	lit.FormIsTopic = true
	if problems := Validate(content, nil); len(problems) != 0 {
		t.Fatalf("formIsTopic allows the equivalent forms: %v", problems)
	}
}

// The real AI named an item "don't_mind" (23/11): the id is fixed, and every card that pointed to it follows.
func TestRepairFixesItemIDs(t *testing.T) {
	content := loadOK(t)
	walk := content.Items.ByID["walk"]
	delete(content.Items.ByID, "walk")
	content.Items.ByID["Don't-Walk"] = walk
	content.Items.Keys[0] = "Don't-Walk"
	for _, list := range []*[]Card{&content.Practice, &content.Context} {
		for n := range *list {
			for k, id := range (*list)[n].Covers {
				if id == "walk" {
					(*list)[n].Covers[k] = "Don't-Walk"
				}
			}
		}
	}
	item(&content, "used_to", func(i *Item) { i.Needs = []string{"Don't-Walk"} })
	Repair(&content, nil)
	if problems := Validate(content, nil); len(problems) != 0 {
		t.Fatalf("valid after the id is fixed: %v", problems)
	}
	if _, ok := content.Items.ByID["dont_walk"]; !ok || content.Items.Keys[0] != "dont_walk" || content.Items.ByID["used_to"].Needs[0] != "dont_walk" || card(&content, "p_match").Covers[0] != "dont_walk" {
		t.Fatalf("the id and what points to it: %v", content.Items.Keys)
	}
}

// The real AI wrote fields in another shape ("syllables": "be-lieve"): the card is read anyway; a card that cannot be read is dropped
// alone, never the whole answer.
func TestCardsAreReadLeniently(t *testing.T) {
	raw := `{"lines": [], "equivalences": [], "items": {}, "practice": [
	  {"id": "s", "type": "stress", "skill": "listen", "q": "Sílaba forte:", "word": "believe", "syllables": "be-lieve", "a": 1},
	  {"id": "o", "type": "order", "skill": "read", "q": "Monte:", "tokens": "I walk home", "answer": "I walk home"},
	  {"id": "m", "type": "minimal_pair", "skill": "listen", "q": "Qual?", "pair": "walk/work"},
	  {"id": "x", "type": "mc", "skill": "read", "q": "?", "opts": {"broken": true}, "a": 0}], "context": []}`
	var c Content
	if err := json.Unmarshal([]byte(raw), &c); err != nil {
		t.Fatalf("one strange card does not break the answer: %v", err)
	}
	if strings.Join(c.Practice[0].Syllables, "|") != "be|lieve" || len(c.Practice[1].Tokens) != 3 || strings.Join(c.Practice[2].Pair, "|") != "walk|work" {
		t.Fatalf("read in the right shape: %+v", c.Practice[:3])
	}
	if problems := checkCard(c.Practice[3], nil); len(problems) == 0 {
		t.Fatal("the card that could not be read is dropped by the repair")
	}
}

// The texts of the prototype (written by hand and studied by the owner) are the real case; they pass when present.
func TestValidatePrototypeTexts(t *testing.T) {
	path := filepath.Join("..", "..", "..", "specs", "004-aprender-idiomas", "prototipo", "trechos", "002-love-keyshia-cole.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Skip("prototype not here")
	}
	var content Content
	if err := json.Unmarshal(raw, &content); err != nil {
		t.Fatal(err)
	}
	if problems := Validate(content, nil); len(problems) != 0 {
		t.Fatalf("%d problems, first: %v", len(problems), problems[:min(len(problems), 10)])
	}
}

// What the real AI did (23/11): the blank in the question with "______" and no text; one card with equivalent options. The form is
// fixed by itself; a card still wrong goes away alone, without taking the whole text with it.
func TestRepairFixesTheFormAndDropsOnlyTheBadCards(t *testing.T) {
	content := loadOK(t)
	gap := card(&content, "t_used_gap")
	gap.Text = ""
	gap.Q = "Complete com a forma certa: 'I ______ walk to school.'"
	bad := card(&content, "c_lit")
	bad.Opts = []string{"won't", "will not", "de carro", "de bicicleta", "de trem"}
	// neg_will's only test card is broken: the item goes, and what only covered it goes too
	item(&content, "neg_will", func(i *Item) { i.Test[0].Say = nil })
	content.Practice = append(content.Practice, Card{ID: "p_only_wont", Type: "tf", Skill: "read", Q: "won't = não vai", A: json.RawMessage("true"), Covers: []string{"neg_will"}},
		Card{ID: "p_both", Type: "tf", Skill: "read", Q: "walk = andar", A: json.RawMessage("true"), Covers: []string{"neg_will", "walk"}})

	dropped := Repair(&content, nil)
	if problems := Validate(content, nil); len(problems) != 0 {
		t.Fatalf("after repair the text is valid: %v", problems)
	}
	if fixed := card(&content, "walk__3"); fixed != nil {
		t.Fatalf("ids are by item: %+v", fixed)
	}
	used := content.Items.ByID["used_to"].Test[0]
	if used.Text != "I ___ walk to school." || used.Q != "Complete com a forma certa:" || used.ID != "used_to__1" {
		t.Fatalf("the blank moved to the text: %+v", used)
	}
	if card(&content, "c_lit") != nil || card(&content, "p_only_wont") != nil {
		t.Fatal("the bad card and the one that only covered a dropped item went away")
	}
	if _, kept := content.Items.ByID["neg_will"]; kept {
		t.Fatal("an item without a valid test card goes away")
	}
	if both := card(&content, "p_both"); both == nil || strings.Join(both.Covers, ",") != "walk" {
		t.Fatalf("a card covering a dropped item and others keeps the others: %+v", both)
	}
	if len(dropped) < 3 {
		t.Fatalf("what was dropped is told: %v", dropped)
	}
	if strings.Join(content.Items.Keys, ",") != "walk,used_to,walk_way" {
		t.Fatalf("items: %v", content.Items.Keys)
	}
	// the real AI left "q" out of the listening cards: their question is fixed by type
	silent := loadOK(t)
	for n := range silent.Practice {
		silent.Practice[n].Q = ""
	}
	Repair(&silent, nil)
	if len(silent.Practice) != 9 || card(&silent, "p_dgap").Q != "Ouça e complete:" || card(&silent, "p_mp").Q != `Ouça: "walk" ou "work"?` || card(&silent, "p_stress").Q != `Ouça e toque a sílaba forte de "today":` {
		t.Fatalf("listening questions by type: %d %+v", len(silent.Practice), silent.Practice)
	}
	if card(&silent, "p_match").Q == "" || card(&silent, "p_odd").Q == "" {
		t.Fatalf("reading questions by type too: %+v", silent.Practice)
	}
	if ids := content.Items.ByID["walk"].Test; ids[0].ID != "walk__1" || ids[1].ID != "walk__2" {
		t.Fatalf("test card ids by item: %s %s", ids[0].ID, ids[1].ID)
	}
}
