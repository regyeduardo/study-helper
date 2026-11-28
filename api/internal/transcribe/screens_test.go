package transcribe

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/regyeduardo/study-helper/api/internal/prompts"
)

// T205 (dono, 28/11: "Tudo em 1 min"; R30): the screen read in Go from what the recording marked (src/lib/generation/frames.ts with
// the marks): the vision model looks at the photos of the screens where the speech points, and the terms come from the text the OCR
// read while recording. No video is decoded.

func screenRecording() Recording {
	return Recording{
		Blocks: []Block{
			{Speaker: "speaker_0", Start: 12, End: 30, Text: "Bom dia. Eu cuido do financeiro."},
			{Speaker: "speaker_1", Start: 31, End: 60, Text: "Olha esse slide aqui, o VGV do trimestre."},
			{Speaker: "speaker_2", Start: 61, End: 80, Text: "E o Pró Soluto entra quando?"},
		},
		Speakers: []Speaker{{ID: "speaker_0", Name: "Falante 1"}, {ID: "speaker_1", Name: "Falante 2"}, {ID: "speaker_2", Name: "Falante 3"}},
	}
}

func screenMarks(photos map[int]string) MarkedScreens {
	return MarkedScreens{
		Screens: []MarkedScreen{
			{At: 1, End: 30, Texts: []OcrText{{Text: "Reunião de orçamento", Confidence: 0.97}}},
			{At: 30, End: 60, Texts: []OcrText{{Text: "VGV do trimestre: R$ 12,4 mi", Confidence: 0.96}}},
			{At: 60, End: 80, Texts: []OcrText{{Text: "Pró Soluto entra em maio", Confidence: 0.95}}},
		},
		Photo: func(_ context.Context, n int) (string, error) {
			if photo, ok := photos[n]; ok {
				return photo, nil
			}
			return "", errors.New("a foto não veio")
		},
	}
}

var allPhotos = map[int]string{0: "data:image/jpeg;base64,TELA0", 1: "data:image/jpeg;base64,TELA1", 2: "data:image/jpeg;base64,TELA2"}

func asksAt(hours string) Chat {
	return func(_ context.Context, _, system string) (string, error) {
		if system == prompts.Text("SCREEN_ASKS_PROMPT") {
			return `{"horas": [` + hours + `]}`, nil
		}
		return "", errors.New("unexpected")
	}
}

func TestTheScreenIsReadFromThePhotosOfTheMarkedScreens(t *testing.T) {
	var mu sync.Mutex
	looked := [][]string{}
	see := func(_ context.Context, images []string, prompt string) (string, error) {
		mu.Lock()
		looked = append(looked, images)
		mu.Unlock()
		if prompt == prompts.Text("SCREEN_TEXT_PROMPT") {
			return `{"texto": "VGV do trimestre: R$ 12,4 mi"}`, nil
		}
		return `{"nome": ""}`, nil
	}
	seen, err := LookAtScreen(context.Background(), screenRecording(), screenMarks(allPhotos), asksAt(`"00:31"`), see, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(seen.Frames) != 1 || seen.Frames[0].At != 31 || seen.Frames[0].Image != "data:image/jpeg;base64,TELA1" || seen.Frames[0].Text != "VGV do trimestre: R$ 12,4 mi" {
		t.Fatalf("frames %+v", seen.Frames)
	}
	// the screen of 31 s (and 33 s, 36 s: the same marked screen) is one look; a voice is looked at by its first speech
	text := 0
	for _, images := range looked {
		if reflect.DeepEqual(images, []string{"data:image/jpeg;base64,TELA1"}) {
			text++
		}
	}
	if text == 0 {
		t.Fatalf("looked %v", looked)
	}
	if !contains(seen.ScreenTerms, "VGV") {
		t.Fatalf("terms %v", seen.ScreenTerms)
	}
}

func contains(list []string, want string) bool {
	for _, item := range list {
		if strings.Contains(item, want) {
			return true
		}
	}
	return false
}

func TestAVoiceIsNamedByTheLitTileAndNoNameGoesToTwoVoices(t *testing.T) {
	see := func(_ context.Context, images []string, prompt string) (string, error) {
		if strings.Contains(prompt, "Falante 1") || strings.Contains(prompt, "Falante 2") {
			return `{"nome": "Natália"}`, nil
		}
		return `{"texto": "", "nome": ""}`, nil
	}
	seen, err := LookAtScreen(context.Background(), screenRecording(), screenMarks(allPhotos), asksAt(``), see, false)
	if err != nil {
		t.Fatal(err)
	}
	named := 0
	for _, s := range seen.Speakers {
		if s.Name == "Natália" {
			named++
		}
	}
	if named > 1 {
		t.Fatalf("one name for two voices: %+v", seen.Speakers)
	}
}

func TestEveryLookFailedTheChosenScreenFailsWithTheReason(t *testing.T) {
	see := func(context.Context, []string, string) (string, error) {
		return "", errors.New("o modelo de visão recusou o pedido (400)")
	}
	_, err := LookAtScreen(context.Background(), screenRecording(), screenMarks(allPhotos), asksAt(`"00:31"`), see, true)
	if err == nil || !strings.Contains(err.Error(), "A tela não foi lida: o modelo de visão recusou o pedido (400)") {
		t.Fatalf("%v", err)
	}
	// not chosen: the same failure is a warning, and the transcription goes on
	seen, err := LookAtScreen(context.Background(), screenRecording(), screenMarks(allPhotos), asksAt(`"00:31"`), see, false)
	if err != nil || !strings.Contains(seen.Warning, "Não deu para ler a tela gravada") {
		t.Fatalf("%v %q", err, seen.Warning)
	}
}

func TestWithoutAVisionModelTheTermsComeFromTheTextReadWhileRecording(t *testing.T) {
	seen, err := LookAtScreen(context.Background(), screenRecording(), screenMarks(allPhotos), asksAt(`"00:31"`), nil, false)
	if err != nil {
		t.Fatal(err)
	}
	if !contains(seen.ScreenTerms, "VGV") || !strings.Contains(seen.Warning, "lida só pelo texto") {
		t.Fatalf("%v %q", seen.ScreenTerms, seen.Warning)
	}
}

func TestTheTermsOfTheScreenAreVotedAsInTheBrowser(t *testing.T) {
	terms := voteTerms([][]OcrText{{{Text: "Projeto Atlas: migração do Postgres", Confidence: 0.95}}, {{Text: "Projeto Atlas e BGV", Confidence: 0.97}}, {{Text: "Kubernets", Confidence: 0.5}}})
	if !contains(terms.Exact, "Projeto Atlas") || !contains(terms.Exact, "Postgres") || !contains(terms.Exact, "BGV") || contains(terms.Exact, "Kubernets") {
		t.Fatalf("%+v", terms)
	}
}
