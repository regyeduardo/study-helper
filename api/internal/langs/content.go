package langs

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
)

// The format of a generated text (prototipo/SCHEMA.md, v2): everything the person answers is closed, so the app grades it by itself.

// Card is one closed question. Only the fields of its type are filled; `A` is an index, a bool (tf) or "same"/"diff" (same_diff),
// and `Say` is a sentence or, in same_diff, the two words.
type Card struct {
	ID          string          `json:"id"`
	Type        string          `json:"type"`
	Skill       string          `json:"skill"`
	Q           string          `json:"q"`
	QEn         string          `json:"qEn,omitempty"`
	Covers      []string        `json:"covers,omitempty"`
	Needs       []string        `json:"needs,omitempty"`
	Expl        string          `json:"expl,omitempty"`
	DP          string          `json:"dp,omitempty"`
	Opts        []string        `json:"opts,omitempty"`
	OptsEn      []string        `json:"optsEn,omitempty"`
	A           json.RawMessage `json:"a,omitempty"`
	Text        string          `json:"text,omitempty"`
	Tokens      []string        `json:"tokens,omitempty"`
	Answer      string          `json:"answer,omitempty"`
	Pairs       [][]string      `json:"pairs,omitempty"`
	Say         json.RawMessage `json:"say,omitempty"`
	Pair        []string        `json:"pair,omitempty"`
	Word        string          `json:"word,omitempty"`
	Syllables   []string        `json:"syllables,omitempty"`
	Answers     []Accepted      `json:"answers,omitempty"`
	Mode        string          `json:"mode,omitempty"`
	Target      string          `json:"target,omitempty"`
	Accept      []string        `json:"accept,omitempty"`
	FormIsTopic bool            `json:"formIsTopic,omitempty"`
}

// UnmarshalJSON reads a card even when the AI wrote a field in another shape (syllables or tokens as one string, the pair as "a/b");
// a card that still cannot be read comes back without a type, and the repair drops it alone.
func (c *Card) UnmarshalJSON(raw []byte) error {
	type plain Card
	var card plain
	if json.Unmarshal(raw, &card) == nil {
		*c = Card(card)
		return nil
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return err
	}
	split := func(key string, separators string) {
		var text string
		if value, ok := fields[key]; ok && json.Unmarshal(value, &text) == nil {
			parts := strings.FieldsFunc(text, func(r rune) bool { return strings.ContainsRune(separators, r) })
			fields[key], _ = json.Marshal(parts)
		}
	}
	split("syllables", "-·| ")
	split("tokens", " |")
	split("pair", "/|,")
	split("opts", "|")
	fixed, _ := json.Marshal(fields)
	if json.Unmarshal(fixed, &card) == nil {
		*c = Card(card)
		return nil
	}
	var id struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(raw, &id)
	*c = Card{ID: id.ID, Type: "unreadable"}
	return nil
}

// Accepted is the answers accepted in one blank; the generation may send just one, as a string.
type Accepted []string

func (a *Accepted) UnmarshalJSON(raw []byte) error {
	var one string
	if json.Unmarshal(raw, &one) == nil {
		*a = Accepted{one}
		return nil
	}
	var many []string
	if err := json.Unmarshal(raw, &many); err != nil {
		return err
	}
	*a = many
	return nil
}

// SayText is what the voice says in the card ("" when it is not one sentence).
func (c Card) SayText() string {
	var text string
	if json.Unmarshal(c.Say, &text) != nil {
		return ""
	}
	return text
}

// SayList is what the voice says, one after the other (a sentence alone or a list of them, as listen_mc may have).
func (c Card) SayList() []string {
	if text := c.SayText(); text != "" {
		return []string{text}
	}
	return c.SayPair()
}

// SayPair is the two words of a same_diff card.
func (c Card) SayPair() []string {
	var pair []string
	if json.Unmarshal(c.Say, &pair) != nil {
		return nil
	}
	return pair
}

// Item is one thing learned from the text, of any area.
type Item struct {
	Area    string            `json:"area"`
	Kind    string            `json:"kind"`
	Label   string            `json:"label"`
	Say     string            `json:"say,omitempty"`
	Meaning string            `json:"meaning"`
	Word    string            `json:"word,omitempty"`
	Pattern string            `json:"pattern,omitempty"`
	Core    string            `json:"core,omitempty"`
	Expl    string            `json:"expl,omitempty"`
	Ex      []string          `json:"ex,omitempty"`
	Needs   []string          `json:"needs,omitempty"`
	Facets  map[string]string `json:"facets,omitempty"`
	Test    []Card            `json:"test"`
}

// Items keeps the items in the order they came (their position in the text).
type Items struct {
	Keys []string
	ByID map[string]Item
}

func (items *Items) UnmarshalJSON(raw []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	start, err := decoder.Token()
	if err != nil {
		return err
	}
	if delim, ok := start.(json.Delim); !ok || delim != '{' {
		return errors.New("items is not an object")
	}
	items.Keys, items.ByID = nil, map[string]Item{}
	for decoder.More() {
		key, err := decoder.Token()
		if err != nil {
			return err
		}
		id, _ := key.(string)
		var item Item
		if err := decoder.Decode(&item); err != nil {
			return err
		}
		if _, seen := items.ByID[id]; !seen {
			items.Keys = append(items.Keys, id)
		}
		items.ByID[id] = item
	}
	_, err = decoder.Token()
	return err
}

func (items Items) MarshalJSON() ([]byte, error) {
	var out bytes.Buffer
	out.WriteByte('{')
	for n, id := range items.Keys {
		if n > 0 {
			out.WriteByte(',')
		}
		key, _ := json.Marshal(id)
		value, err := json.Marshal(items.ByID[id])
		if err != nil {
			return nil, err
		}
		out.Write(key)
		out.WriteByte(':')
		out.Write(value)
	}
	out.WriteByte('}')
	return out.Bytes(), nil
}

// Add puts an item at the end (or replaces the one with the same id, in its place).
func (items *Items) Add(id string, item Item) {
	if items.ByID == nil {
		items.ByID = map[string]Item{}
	}
	if _, seen := items.ByID[id]; !seen {
		items.Keys = append(items.Keys, id)
	}
	items.ByID[id] = item
}

// Content is what the generation gives for a text: its items, the language practice, the context part and the equivalent forms.
type Content struct {
	Lines        []string   `json:"lines"`
	Equivalences [][]string `json:"equivalences"`
	// Reuse are the ready items (shared by everyone, in R2) the piece uses: the AI only names them, never writes them again
	Reuse    []string `json:"reuse,omitempty"`
	Items    Items    `json:"items"`
	Practice []Card   `json:"practice"`
	Context  []Card   `json:"context"`
}
