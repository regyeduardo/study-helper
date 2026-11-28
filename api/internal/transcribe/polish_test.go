package transcribe

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/regyeduardo/study-helper/api/internal/prompts"
)

// T206: the finishing of the transcription (title, names of the voices, corrections) in Go, as src/lib/generation/polish.ts does it;
// the same cases as src/test/generation/polish.test.ts.

func meeting(extra int) Recording {
	blocks := []Block{{Speaker: "mic", Start: 0, End: 3, Text: "Marina, você manda a proposta do pics?"}, {Speaker: "speaker_0", Start: 4, End: 8, Text: "Mando sim, falei com o João Vito ontem."}}
	for i := 0; i < extra; i++ {
		blocks = append(blocks, Block{Speaker: "speaker_1", Start: float64(20 + i), End: float64(21 + i), Text: strings.Repeat("x", 400)})
	}
	blocks = append(blocks, Block{Speaker: "mic", Start: 900, End: 901, Text: "Valeu, Marina."})
	return Recording{
		Blocks:   blocks,
		Speakers: []Speaker{{ID: "mic", Name: "Regy Niles"}, {ID: "speaker_0", Name: "Falante 2"}, {ID: "speaker_1", Name: "João Vitor Almeida"}},
		Frames:   []Frame{{At: 0, Image: "i", Text: "Participantes: João Vitor Almeida"}},
	}
}

const polishAnswer = `{"titulo": "Proposta do PIX para maio.", "nomes": [{"falante": "Falante 2", "nome": "Marina", "citacao": "Marina, você manda"}, {"falante": "João Vitor Almeida", "nome": "João", "citacao": "João Vito"}, {"falante": "Regy Niles", "nome": "João", "citacao": "João Vito"}], "correcoes": [{"fala": 1, "de": "pics", "para": "PIX"}, {"fala": 2, "de": "João Vito", "para": "João Vitor"}]}`

type chatCall struct{ user, system string }

func TestTitleNamesAndCorrectionsComeFromOneCall(t *testing.T) {
	calls := []chatCall{}
	chat := func(_ context.Context, user, system string) (string, error) {
		calls = append(calls, chatCall{user, system})
		return polishAnswer, nil
	}
	recording, title := Polish(context.Background(), meeting(0), chat, "PIX", "")
	if len(calls) != 1 || calls[0].system != prompts.Text("POLISH_PROMPT") {
		t.Fatalf("calls %d", len(calls))
	}
	for _, want := range []string{`Primeiro trecho: devolva também o "titulo".`, "Termos que aparecem nesta gravação: PIX.", "Escrito na tela durante a reunião: Participantes: João Vitor Almeida", "2 | Falante 2 [00:04]: Mando sim, falei com o João Vito ontem."} {
		if !strings.Contains(calls[0].user, want) {
			t.Fatalf("missing %q in %q", want, calls[0].user)
		}
	}
	if title != "Proposta do PIX para maio" {
		t.Fatalf("title %q", title)
	}
	names := []string{}
	for _, s := range recording.Speakers {
		names = append(names, s.Name)
	}
	if !reflect.DeepEqual(names, []string{"Regy Niles", "Marina", "João Vitor Almeida"}) {
		t.Fatalf("names %v", names)
	}
	if recording.Blocks[0].Text != "Marina, você manda a proposta do PIX?" || recording.Blocks[1].Text != "Mando sim, falei com o João Vitor ontem." || recording.Blocks[1].Original != "Mando sim, falei com o João Vito ontem." {
		t.Fatalf("blocks %+v", recording.Blocks[:2])
	}
}

func TestALongTranscriptGoesInPiecesAtOnceAndTheTitleFromItsOwnCall(t *testing.T) {
	var mu sync.Mutex
	calls := []chatCall{}
	active, peak := 0, 0
	chat := func(_ context.Context, user, system string) (string, error) {
		mu.Lock()
		calls = append(calls, chatCall{user, system})
		active++
		peak = max(peak, active)
		mu.Unlock()
		time.Sleep(20 * time.Millisecond)
		mu.Lock()
		active--
		mu.Unlock()
		if system == prompts.Text("TITLE_PROMPT") {
			return `{"titulo": "Proposta do PIX para maio"}`, nil
		}
		return `{"nomes": [], "correcoes": [{"fala": 1, "de": "pics", "para": "PIX"}]}`, nil
	}
	recording, title := Polish(context.Background(), meeting((chunkChars*3/2+399)/400), chat, "", "")
	pieces, titles := 0, []string{}
	for _, c := range calls {
		switch c.system {
		case prompts.Text("POLISH_PROMPT"):
			pieces++
			if !strings.Contains(c.user, `não devolva "titulo"`) || len(c.user) >= chunkChars/2 || !strings.Contains(c.user, "Escrito na tela durante a reunião") {
				t.Fatalf("piece %q", c.user[:120])
			}
		case prompts.Text("TITLE_PROMPT"):
			titles = append(titles, c.user)
		}
	}
	if pieces < 4 || len(titles) != 1 || !strings.Contains(titles[0], "1 | Regy Niles [00:00]: Marina, você manda a proposta do pics?") || len(titles[0]) <= chunkChars*9/10 {
		t.Fatalf("pieces %d titles %d", pieces, len(titles))
	}
	if title != "Proposta do PIX para maio" || peak != len(calls) || recording.Blocks[0].Text != "Marina, você manda a proposta do PIX?" {
		t.Fatalf("title %q peak %d/%d %q", title, peak, len(calls), recording.Blocks[0].Text)
	}
}

func TestTheMicrophoneWithoutANameIsNamedLikeAnyOtherVoice(t *testing.T) {
	unnamed := Recording{Blocks: []Block{{Speaker: "speaker_0", Start: 0, End: 3, Text: "Pode ir, Reg?"}, {Speaker: "mic", Start: 4, End: 8, Text: "Posso, vou mostrar a tela."}}, Speakers: []Speaker{{ID: "speaker_0", Name: "Falante 1"}, {ID: "mic", Name: "Quem gravou"}}}
	var asked string
	chat := func(_ context.Context, user, _ string) (string, error) {
		asked = user
		answer, _ := json.Marshal(map[string]any{"titulo": "", "nomes": []map[string]string{{"falante": "Quem gravou", "nome": "Reg", "citacao": "Pode ir, Reg?"}}, "correcoes": []any{}})
		return string(answer), nil
	}
	recording, _ := Polish(context.Background(), unnamed, chat, "", "")
	if !strings.Contains(asked, "2 | Quem gravou [00:04]: Posso, vou mostrar a tela.") || recording.Speakers[1] != (Speaker{ID: "mic", Name: "Reg", Suggested: true}) {
		t.Fatalf("%q %+v", asked, recording.Speakers)
	}
}

func TestWhenTheAIFailsTheTranscriptionStaysAsHeardAndSaysWhy(t *testing.T) {
	chat := func(context.Context, string, string) (string, error) { return "", errors.New("402 sem saldo") }
	recording, _ := Polish(context.Background(), meeting(0), chat, "", "")
	if !reflect.DeepEqual(recording.Blocks, meeting(0).Blocks) || recording.Warning != "A revisão por IA não rodou (nomes e palavras ficaram como o áudio saiu): 402 sem saldo" {
		t.Fatalf("%+v %q", recording.Blocks, recording.Warning)
	}
}
