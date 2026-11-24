package langs

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// T013: the validator of the generated format (prototipo/SCHEMA.md). Each problem is one short line in English, sent back to the AI
// to fix; a text is only ready when there is none.

var (
	itemID = regexp.MustCompile(`^[a-z0-9][a-z0-9_]*$`)
	areas  = set("lexico", "gramatica", "semantica", "fonologia", "ortografia", "registro", "pragmatica")
	kinds  = set("word", "fixed_expression", "phrasal_verb", "idiom", "collocation", "structure", "contraction", "spoken_form", "sense",
		"sound", "stress", "linking", "spelling", "register", "function", "discourse")
	skills = map[string]string{
		"mc": "read", "tf": "read", "gap": "read", "order": "read", "match": "read", "odd": "read",
		"listen_mc": "listen", "minimal_pair": "listen", "same_diff": "listen", "find_diff": "listen", "stress": "listen",
		"dictation": "listen", "dictation_gap": "listen", "speak": "speak",
	}
	choice      = set("mc", "gap", "listen_mc", "odd")
	speakModes  = set("repeat", "read", "shadow", "answer", "translate")
	dpLevels    = set("literal", "reorganizacao", "inferencia", "previsao", "avaliacao")
	blank       = "___"
	optionCount = 5
)

func set(values ...string) map[string]bool {
	out := map[string]bool{}
	for _, value := range values {
		out[value] = true
	}
	return out
}

// Validate gives every problem of a generated text. `base` is the items the language already has (id → its needs), which the text
// may need without bringing them again.
func Validate(c Content, base map[string][]string) []string {
	var problems []string
	add := func(format string, args ...any) { problems = append(problems, fmt.Sprintf(format, args...)) }
	known := func(id string) bool {
		if _, ok := c.Items.ByID[id]; ok {
			return true
		}
		_, ok := base[id]
		return ok
	}

	// a form may be in two groups ("is not" is "isn't" and one of the "ain't")
	for n, group := range c.Equivalences {
		if len(group) < 2 {
			add("equivalences[%d]: a group needs 2 forms or more", n)
		}
		for _, form := range group {
			if Clean(form) == "" {
				add("equivalences[%d]: empty form", n)
			}
		}
	}

	if len(c.Items.Keys) == 0 {
		add("no items")
	}
	for _, id := range c.Items.Keys {
		it := c.Items.ByID[id]
		if !itemID.MatchString(id) {
			add("item id %q: use lower case letters, digits and _", id)
		}
		if !areas[it.Area] {
			add("%s: area %q is not one of lexico, gramatica, semantica, fonologia, ortografia, registro, pragmatica", id, it.Area)
		}
		if !kinds[it.Kind] {
			add("%s: kind %q is not in the list", id, it.Kind)
		}
		if strings.TrimSpace(it.Label) == "" || strings.TrimSpace(it.Meaning) == "" {
			add("%s: label and meaning are required", id)
		}
		if it.Kind == "sense" && (it.Word == "" || it.Pattern == "" || it.Core == "") {
			add("%s: a sense needs word, pattern and core", id)
		}
		for _, need := range it.Needs {
			if need == id {
				add("%s: needs itself", id)
			} else if !known(need) {
				add("%s: needs %s, which is not an item of the text nor of the base", id, need)
			}
		}
		if len(it.Test) == 0 {
			add("%s: no test card (2 or 3 closed cards that prove the item)", id)
		}
	}
	if cycle := needsCycle(c, base); cycle != "" {
		add("needs make a cycle: %s", cycle)
	}

	cardIDs := map[string]bool{}
	covered := map[string]bool{}
	check := func(card Card, part, owner string) {
		if card.ID == "" {
			add("a card without id in %s", part)
			return
		}
		if cardIDs[card.ID] {
			add("card id %s repeated", card.ID)
		}
		cardIDs[card.ID] = true
		for _, problem := range checkCard(card, c.Equivalences) {
			add("%s: %s", card.ID, problem)
		}
		for _, id := range card.Covers {
			if !known(id) {
				add("%s: covers %s, which is not an item", card.ID, id)
			}
			covered[id] = true
		}
		for _, id := range card.Needs {
			if !known(id) {
				add("%s: needs %s, which is not an item", card.ID, id)
			}
		}
		if owner != "" {
			covered[owner] = true
		}
		if part == "context" && !dpLevels[card.DP] {
			add("%s: dp must be literal, reorganizacao, inferencia, previsao or avaliacao", card.ID)
		}
	}
	for _, id := range c.Items.Keys {
		for _, card := range c.Items.ByID[id].Test {
			check(card, "test", id)
		}
	}
	for _, card := range c.Practice {
		check(card, "practice", "")
	}
	for _, card := range c.Context {
		check(card, "context", "")
	}
	for _, id := range c.Items.Keys {
		if !covered[id] {
			add("%s: no card covers it", id)
		}
	}
	return problems
}

// needsCycle is one cycle of "needs" (through the text and the base), or "".
func needsCycle(c Content, base map[string][]string) string {
	edges := map[string][]string{}
	for id, needs := range base {
		edges[id] = needs
	}
	for _, id := range c.Items.Keys {
		edges[id] = c.Items.ByID[id].Needs
	}
	ids := make([]string, 0, len(edges))
	for id := range edges {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	const (
		fresh = iota
		open
		done
	)
	state := map[string]int{}
	var path []string
	var found string
	var visit func(string) bool
	visit = func(id string) bool {
		switch state[id] {
		case open:
			start := 0
			for n, step := range path {
				if step == id {
					start = n
				}
			}
			found = strings.Join(append(append([]string{}, path[start:]...), id), " → ")
			return true
		case done:
			return false
		}
		state[id] = open
		path = append(path, id)
		for _, need := range edges[id] {
			if visit(need) {
				return true
			}
		}
		path = path[:len(path)-1]
		state[id] = done
		return false
	}
	for _, id := range ids {
		if visit(id) {
			return found
		}
	}
	return ""
}

func index(raw json.RawMessage) (int, bool) {
	var n int
	if json.Unmarshal(raw, &n) != nil {
		return 0, false
	}
	return n, true
}

func words(text string) []string { return strings.Fields(text) }

// checkCard is what is wrong in one card, by its type.
func checkCard(card Card, groups [][]string) []string {
	var out []string
	bad := func(format string, args ...any) { out = append(out, fmt.Sprintf(format, args...)) }
	skill, known := skills[card.Type]
	if !known {
		bad("type %s is not one of mc, tf, gap, order, match, odd, listen_mc, minimal_pair, same_diff, find_diff, stress, dictation, dictation_gap, speak", card.Type)
		return out
	}
	if card.Skill != skill {
		bad("skill must be %s for %s", skill, card.Type)
	}
	if strings.TrimSpace(card.Q) == "" {
		bad("q (the question in Portuguese) is empty")
	}
	if choice[card.Type] {
		if len(card.Opts) != optionCount {
			bad("%d options needed in %s (it has %d)", optionCount, card.Type, len(card.Opts))
		}
		if len(card.OptsEn) > 0 && len(card.OptsEn) != len(card.Opts) {
			bad("optsEn must have one option per opts")
		}
		if a, ok := index(card.A); !ok || a < 0 || a >= len(card.Opts) {
			bad("a must be the index of the right option (0 to %d)", len(card.Opts)-1)
		}
		for i := range card.Opts {
			if strings.TrimSpace(card.Opts[i]) == "" {
				bad("empty option")
			}
			for j := i + 1; j < len(card.Opts); j++ {
				if Clean(card.Opts[i]) == Clean(card.Opts[j]) {
					bad("options %d and %d are the same", i, j)
				} else if !card.FormIsTopic && Same(card.Opts[i], card.Opts[j], groups) {
					bad("equivalent options %q and %q (use formIsTopic only when the form is the subject)", card.Opts[i], card.Opts[j])
				}
			}
		}
	}
	switch card.Type {
	case "gap":
		if strings.Count(card.Text, blank) != 1 {
			bad("text must have exactly one %s", blank)
		}
	case "listen_mc":
		said := card.SayList()
		if len(said) == 0 || strings.TrimSpace(strings.Join(said, "")) == "" {
			bad("say (what the voice says) is empty")
		}
	case "dictation":
		if strings.TrimSpace(card.SayText()) == "" {
			bad("say (the sentence the voice says) is empty")
		}
	case "tf":
		var value bool
		if json.Unmarshal(card.A, &value) != nil {
			bad("a must be true or false")
		}
	case "order":
		given := Canonical(strings.Join(card.Tokens, " "), nil)
		want := Canonical(card.Answer, nil)
		sort.Strings(given)
		sort.Strings(want)
		if len(card.Tokens) < 2 || strings.Join(given, " ") != strings.Join(want, " ") {
			bad("tokens must be exactly the words of answer")
		}
	case "match":
		if len(card.Pairs) < 2 {
			bad("match needs 2 pairs or more")
		}
		left, right := map[string]bool{}, map[string]bool{}
		for _, pair := range card.Pairs {
			if len(pair) != 2 || strings.TrimSpace(pair[0]) == "" || strings.TrimSpace(pair[1]) == "" {
				bad("each pair is [left, right]")
				continue
			}
			if left[Clean(pair[0])] || right[Clean(pair[1])] {
				bad("a side of the pairs repeats")
			}
			left[Clean(pair[0])], right[Clean(pair[1])] = true, true
		}
	case "minimal_pair":
		if len(card.Pair) != 2 || Clean(card.Pair[0]) == "" || Clean(card.Pair[0]) == Clean(card.Pair[1]) {
			bad("pair must be two different words")
		}
	case "same_diff":
		pair := card.SayPair()
		var a string
		_ = json.Unmarshal(card.A, &a)
		if len(pair) != 2 {
			bad("say must be the two words")
		} else if a != "same" && a != "diff" {
			bad("a must be same or diff")
		} else if (Clean(pair[0]) == Clean(pair[1])) != (a == "same") {
			bad("a says %s but the two words are %v", a, pair)
		}
	case "find_diff":
		shown, said := words(card.Text), words(card.SayText())
		a, ok := index(card.A)
		changed := []int{}
		if len(shown) == len(said) {
			for n := range shown {
				if Clean(shown[n]) != Clean(said[n]) {
					changed = append(changed, n)
				}
			}
		}
		if len(shown) == 0 || len(shown) != len(said) || len(changed) != 1 || !ok || changed[0] != a {
			bad("text and say must have the same words but one, and a is the index of that word in text")
		}
	case "stress":
		a, ok := index(card.A)
		if len(card.Syllables) < 2 || !ok || a < 0 || a >= len(card.Syllables) {
			bad("syllables need 2 or more and a is the index of the strong one")
		}
		if Clean(strings.Join(card.Syllables, "")) != strings.ReplaceAll(Clean(card.Word), "-", "") {
			bad("syllables together must make word")
		}
	case "dictation_gap":
		count := strings.Count(card.Text, blank)
		if count == 0 || count != len(card.Answers) {
			bad("%d blanks in text but %d answers (one list of accepted answers per blank)", count, len(card.Answers))
			break
		}
		filled := card.Text
		for _, accepted := range card.Answers {
			if len(accepted) == 0 || strings.TrimSpace(accepted[0]) == "" {
				bad("each blank needs an accepted answer")
				return out
			}
			filled = strings.Replace(filled, blank, accepted[0], 1)
		}
		if !Same(filled, card.SayText(), groups) {
			bad("the blanks filled with the answers must give say")
		}
	case "speak":
		if !speakModes[card.Mode] {
			bad("mode must be repeat, read, shadow, answer or translate")
		}
		if strings.TrimSpace(card.Target) == "" {
			bad("target (what the person must say) is empty")
		}
	}
	return out
}

var (
	blanks       = regexp.MustCompile(`_{3,}`)
	quotedBlank  = regexp.MustCompile(`['"“‘]([^'"”’]*___[^'"”’]*)['"”’]`)
	blankedTypes = set("gap", "dictation_gap")
)

// questions are the fixed question of each type, for a card the AI left without one (the real AI did, 23/11).
func question(card Card) string {
	switch card.Type {
	case "listen_mc":
		return "Ouça e escolha:"
	case "dictation":
		return "Ouça e escreva a frase:"
	case "dictation_gap":
		return "Ouça e complete:"
	case "find_diff":
		return "Ouça e toque a palavra que mudou:"
	case "minimal_pair":
		if len(card.Pair) == 2 {
			return fmt.Sprintf("Ouça: %q ou %q?", card.Pair[0], card.Pair[1])
		}
	case "same_diff":
		return "Ouça as duas: são iguais?"
	case "stress":
		return fmt.Sprintf("Ouça e toque a sílaba forte de %q:", card.Word)
	case "order":
		return "Monte a frase:"
	case "match":
		return "Ligue os pares:"
	case "odd":
		return "Ache o intruso:"
	case "gap":
		return "Complete:"
	case "speak":
		return "Ouça e repita:"
	}
	return ""
}

// fixBlanks puts every blank as "___", moves a sentence with the blank from the question to the text and gives a question to a card
// left without one.
func fixBlanks(card *Card) {
	defer func() {
		if strings.TrimSpace(card.Q) == "" {
			card.Q = question(*card)
		}
	}()
	card.Q = blanks.ReplaceAllString(card.Q, blank)
	card.Text = blanks.ReplaceAllString(card.Text, blank)
	if !blankedTypes[card.Type] || strings.Contains(card.Text, blank) || !strings.Contains(card.Q, blank) {
		return
	}
	if found := quotedBlank.FindStringSubmatchIndex(card.Q); found != nil {
		card.Text = strings.TrimSpace(card.Q[found[2]:found[3]])
		card.Q = strings.TrimSpace(card.Q[:found[0]] + card.Q[found[1]:])
		return
	}
	if at := strings.LastIndex(card.Q, ":"); at >= 0 && strings.Contains(card.Q[at:], blank) {
		card.Text = strings.TrimSpace(card.Q[at+1:])
		card.Q = strings.TrimSpace(card.Q[:at+1])
		return
	}
	card.Text, card.Q = card.Q, "Complete:"
}

// Repair fixes what is only form (blanks, test card ids by item) and takes away, one by one, what is still wrong: a bad card, an
// item left without a valid test card, a card that only covered what went away. It gives what was taken away. A text with something
// wrong keeps all the rest (owner, 23/11: one bad card never takes the whole text).
func Repair(c *Content, base map[string][]string) []string {
	var dropped []string
	groups := [][]string{}
	for _, group := range c.Equivalences {
		if len(group) >= 2 {
			groups = append(groups, group)
		}
	}
	c.Equivalences = groups
	fixIDs(c)
	for _, id := range c.Items.Keys {
		it := c.Items.ByID[id]
		for n := range it.Test {
			fixBlanks(&it.Test[n])
			it.Test[n].ID = fmt.Sprintf("%s__%d", id, n+1)
		}
		c.Items.ByID[id] = it
	}
	for n := range c.Practice {
		fixBlanks(&c.Practice[n])
	}
	for n := range c.Context {
		fixBlanks(&c.Context[n])
	}
	for changed := true; changed; {
		changed = false
		known := func(id string) bool {
			if _, ok := c.Items.ByID[id]; ok {
				return true
			}
			_, ok := base[id]
			return ok
		}
		// a card is kept when its type is right and it still covers something that exists
		keep := func(card *Card, part string) bool {
			if problems := checkCard(*card, c.Equivalences); len(problems) > 0 {
				dropped = append(dropped, card.ID+": "+problems[0])
				return false
			}
			if part == "context" && !dpLevels[card.DP] {
				dropped = append(dropped, card.ID+": dp")
				return false
			}
			had := len(card.Covers)
			card.Covers = filter(card.Covers, known)
			card.Needs = filter(card.Needs, known)
			if had > 0 && len(card.Covers) == 0 {
				dropped = append(dropped, card.ID+": covered only what went away")
				return false
			}
			return true
		}
		keys := []string{}
		for _, id := range c.Items.Keys {
			it := c.Items.ByID[id]
			fine := itemID.MatchString(id) && areas[it.Area] && kinds[it.Kind] && strings.TrimSpace(it.Label) != "" && strings.TrimSpace(it.Meaning) != "" &&
				(it.Kind != "sense" || (it.Word != "" && it.Pattern != "" && it.Core != ""))
			tests := []Card{}
			for _, card := range it.Test {
				// a test card always covers its own item
				if !contains(card.Covers, id) {
					card.Covers = append([]string{id}, card.Covers...)
				}
				if fine && keep(&card, "test") {
					tests = append(tests, card)
				}
			}
			if !fine || len(tests) == 0 {
				dropped = append(dropped, id+": item without a valid test card")
				delete(c.Items.ByID, id)
				changed = true
				continue
			}
			if len(tests) != len(it.Test) {
				changed = true
			}
			it.Test = tests
			c.Items.ByID[id] = it
			keys = append(keys, id)
		}
		c.Items.Keys = keys
		for _, id := range c.Items.Keys {
			it := c.Items.ByID[id]
			needs := filter(it.Needs, func(need string) bool { return need != id && known(need) })
			if len(needs) != len(it.Needs) {
				changed = true
			}
			it.Needs = needs
			c.Items.ByID[id] = it
		}
		if cycle := needsCycle(*c, base); cycle != "" {
			first := strings.SplitN(cycle, " → ", 2)[0]
			if it, ok := c.Items.ByID[first]; ok {
				it.Needs = nil
				c.Items.ByID[first] = it
				dropped = append(dropped, first+": needs in a cycle")
				changed = true
			}
		}
		for _, part := range []*[]Card{&c.Practice, &c.Context} {
			name := "practice"
			if part == &c.Context {
				name = "context"
			}
			cards := []Card{}
			for _, card := range *part {
				if keep(&card, name) {
					cards = append(cards, card)
				} else {
					changed = true
				}
			}
			*part = cards
		}
	}
	// a card id twice: the second gets a number
	seen := map[string]bool{}
	rename := func(card *Card) {
		if card.ID == "" {
			card.ID = "card"
		}
		id := card.ID
		for n := 2; seen[id]; n++ {
			id = fmt.Sprintf("%s_%d", card.ID, n)
		}
		card.ID = id
		seen[id] = true
	}
	for _, id := range c.Items.Keys {
		it := c.Items.ByID[id]
		for n := range it.Test {
			rename(&it.Test[n])
		}
	}
	for n := range c.Practice {
		rename(&c.Practice[n])
	}
	for n := range c.Context {
		rename(&c.Context[n])
	}
	return dropped
}

var notID = regexp.MustCompile(`[^a-z0-9_]+`)

// slug is an id as the format wants it: lower case, the apostrophe out ("don't" → "dont"), anything else as "_".
func slug(id string) string {
	id = strings.NewReplacer("'", "", "’", "").Replace(strings.ToLower(strings.TrimSpace(id)))
	return strings.Trim(notID.ReplaceAllString(id, "_"), "_")
}

// fixIDs puts every item id in the right shape, and the cards and needs that point to it follow.
func fixIDs(c *Content) {
	renamed := map[string]string{}
	keys := []string{}
	byID := map[string]Item{}
	for _, id := range c.Items.Keys {
		fixed := slug(id)
		if fixed == "" {
			fixed = id
		}
		renamed[id] = fixed
		if _, seen := byID[fixed]; seen {
			continue
		}
		keys = append(keys, fixed)
		byID[fixed] = c.Items.ByID[id]
	}
	follow := func(ids []string) []string {
		out := make([]string, len(ids))
		for n, id := range ids {
			if fixed, ok := renamed[id]; ok {
				out[n] = fixed
			} else {
				out[n] = id
			}
		}
		return out
	}
	for _, id := range keys {
		it := byID[id]
		it.Needs = follow(it.Needs)
		for n := range it.Test {
			it.Test[n].Covers = follow(it.Test[n].Covers)
			it.Test[n].Needs = follow(it.Test[n].Needs)
		}
		byID[id] = it
	}
	for _, list := range []*[]Card{&c.Practice, &c.Context} {
		for n := range *list {
			(*list)[n].Covers = follow((*list)[n].Covers)
			(*list)[n].Needs = follow((*list)[n].Needs)
		}
	}
	c.Reuse = follow(c.Reuse)
	c.Items.Keys, c.Items.ByID = keys, byID
}

func filter(ids []string, keep func(string) bool) []string {
	out := []string{}
	for _, id := range ids {
		if keep(id) {
			out = append(out, id)
		}
	}
	return out
}
