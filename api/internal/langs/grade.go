package langs

import (
	"regexp"
	"sort"
	"strings"
)

// Correção sem IA (spec 004), the same as src/lib/langs/grade.ts: equivalent forms of the language become the same form on both
// sides before comparing; gaps compare exactly against the accepted answers.

var (
	apostrophes = strings.NewReplacer("’", "'", "`", "'", "´", "'")
	punctuation = regexp.MustCompile(`[.,!?;:"“”()¿¡…]`)
	spaces      = regexp.MustCompile(`\s+`)
)

// Clean is the text in lower case, with one kind of apostrophe and no punctuation.
func Clean(text string) string {
	text = apostrophes.Replace(strings.ToLower(text))
	return strings.TrimSpace(spaces.ReplaceAllString(punctuation.ReplaceAllString(text, " "), " "))
}

func tokens(text string) []string {
	return strings.Fields(Clean(text))
}

// spelledOut is the group's form with the most words (the first one on a tie): "won't" and "will not" become "will not".
func spelledOut(group []string) []string {
	best := []string{}
	for _, item := range group {
		if form := tokens(item); len(form) > len(best) {
			best = form
		}
	}
	return best
}

// Canonical changes each form of the table into its group's spelled-out form, left to right, taking the longest form. Spelled out,
// groups that cross give the same ("he's not" = "he isn't" = "he is not"; "I will not" = "I won't" = "I'll not").
func Canonical(text string, groups [][]string) []string {
	type form struct{ form, to []string }
	forms := []form{}
	for _, group := range groups {
		for _, item := range group {
			forms = append(forms, form{tokens(item), spelledOut(group)})
		}
	}
	sort.SliceStable(forms, func(a, b int) bool { return len(forms[a].form) > len(forms[b].form) })
	words := tokens(text)
	out := []string{}
	for i := 0; i < len(words); {
		matched := false
		for _, item := range forms {
			if len(item.form) == 0 || i+len(item.form) > len(words) {
				continue
			}
			hit := true
			for k, word := range item.form {
				if words[i+k] != word {
					hit = false
					break
				}
			}
			if hit {
				out = append(out, item.to...)
				i += len(item.form)
				matched = true
				break
			}
		}
		if !matched {
			out = append(out, words[i])
			i++
		}
	}
	return out
}

// Same says whether two answers say the same, by the table of equivalences.
func Same(a, b string, groups [][]string) bool {
	return strings.Join(Canonical(a, groups), " ") == strings.Join(Canonical(b, groups), " ")
}

// Exact compares a gap with the accepted answers.
func Exact(value string, accepted []string) bool {
	for _, item := range accepted {
		if Clean(item) == Clean(value) {
			return true
		}
	}
	return false
}

// Word is one word of a word-by-word difference: ok, miss (expected, not said) or extra (said, not expected).
type Word struct {
	W string `json:"w"`
	K string `json:"k"`
}

// Diff is the word-by-word difference (LCS) between the expected and the given.
func Diff(expected, given string, groups [][]string) []Word {
	e, g := Canonical(expected, groups), Canonical(given, groups)
	m, n := len(e), len(g)
	L := make([][]int, m+1)
	for i := range L {
		L[i] = make([]int, n+1)
	}
	for i := m - 1; i >= 0; i-- {
		for j := n - 1; j >= 0; j-- {
			if e[i] == g[j] {
				L[i][j] = L[i+1][j+1] + 1
			} else {
				L[i][j] = max(L[i+1][j], L[i][j+1])
			}
		}
	}
	out := []Word{}
	for i, j := 0, 0; i < m || j < n; {
		switch {
		case i < m && j < n && e[i] == g[j]:
			out = append(out, Word{e[i], "ok"})
			i++
			j++
		case j < n && (i >= m || L[i][j+1] >= L[i+1][j]):
			out = append(out, Word{g[j], "extra"})
			j++
		default:
			out = append(out, Word{e[i], "miss"})
			i++
		}
	}
	return out
}
