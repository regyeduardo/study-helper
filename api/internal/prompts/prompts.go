// Package prompts holds the instructions to the AI the app uses (src/lib/generation/prompts.data.ts), embedded so the backend in Go asks
// the same as the browser (T204, FR-084). scripts/prompts-go.py writes prompts.json; src/test/generation/prompts-go.test.ts says when the
// two drift apart.
package prompts

import (
	_ "embed"
	"encoding/json"
	"fmt"
)

//go:embed prompts.json
var raw []byte

var texts = func() map[string]json.RawMessage {
	out := map[string]json.RawMessage{}
	if err := json.Unmarshal(raw, &out); err != nil {
		panic(fmt.Sprintf("prompts.json: %v", err))
	}
	return out
}()

// Text is the instruction of that name ("POLISH_PROMPT"); it panics on a name that does not exist (a typo, caught by the tests).
func Text(name string) string {
	var text string
	if err := json.Unmarshal(texts[name], &text); err != nil {
		panic(fmt.Sprintf("prompts: %s is not a text", name))
	}
	return text
}

// Int is a number of the instructions ("PREP_MIN_CHARS").
func Int(name string) int {
	var value int
	if err := json.Unmarshal(texts[name], &value); err != nil {
		panic(fmt.Sprintf("prompts: %s is not a number", name))
	}
	return value
}

// Entry is one text of a table of the instructions ("FILE_TYPE_FOCUS", "class"); "" when the table has no such key.
func Entry(name, key string) string {
	var table map[string]string
	if err := json.Unmarshal(texts[name], &table); err != nil {
		panic(fmt.Sprintf("prompts: %s is not a table", name))
	}
	return table[key]
}
