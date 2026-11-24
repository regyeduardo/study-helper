package langs

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

// T010 (spec 004): the same cases as src/test/langs/grade.test.ts; both sides give the same result for the same table.
var groups = [][]string{{"will not", "won't"}, {"do not", "don't"}, {"going to", "gonna"}}

func TestSameWithEquivalences(t *testing.T) {
	if !Same("I won't give up.", "I will not give up", groups) || !Same("I WILL NOT give up!", "i won't give up", groups) {
		t.Fatal("won't = will not")
	}
	if Same("I won't go", "I don't go", groups) {
		t.Fatal("won't is not don't")
	}
}

func TestCanonicalLongestLeftToRight(t *testing.T) {
	got := Canonical("I'm gonna say I won't", groups)
	want := []string{"i'm", "going", "to", "say", "i", "will", "not"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%v", got)
	}
}

func TestDiffWordByWord(t *testing.T) {
	got := Diff("you can borrow my car as long as you are careful", "you can borrow car as lung as you are careful", groups)
	want := []Word{{"you", "ok"}, {"can", "ok"}, {"borrow", "ok"}, {"my", "miss"}, {"car", "ok"}, {"as", "ok"}, {"lung", "extra"}, {"long", "miss"}, {"as", "ok"}, {"you", "ok"}, {"are", "ok"}, {"careful", "ok"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%v", got)
	}
}

func TestExactGap(t *testing.T) {
	if !Exact(" Gave ", []string{"gave"}) || Exact("give", []string{"gave", "had given"}) {
		t.Fatal("gap")
	}
}

// T101 (spec 004, SC-003): the same 50 equivalent and inflected forms as src/test/langs/equivalences.test.ts; 100% count the same.
func TestFiftyEquivalentForms(t *testing.T) {
	raw, err := os.ReadFile("testdata/equivalences-50.json")
	if err != nil {
		t.Fatal(err)
	}
	var data struct {
		Groups    [][]string  `json:"groups"`
		Same      [][2]string `json:"same"`
		Different [][2]string `json:"different"`
	}
	if err := json.Unmarshal(raw, &data); err != nil {
		t.Fatal(err)
	}
	if len(data.Same) != 50 {
		t.Fatalf("%d cases", len(data.Same))
	}
	for _, pair := range data.Same {
		if !Same(pair[0], pair[1], data.Groups) || !Same(pair[1], pair[0], data.Groups) {
			t.Errorf("not the same: %q × %q", pair[0], pair[1])
		}
	}
	for _, pair := range data.Different {
		if Same(pair[0], pair[1], data.Groups) {
			t.Errorf("the same: %q × %q", pair[0], pair[1])
		}
	}
}
