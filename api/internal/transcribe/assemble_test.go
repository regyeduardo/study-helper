package transcribe

import (
	"math"
	"reflect"
	"testing"
)

// T204 (dono, 28/11: "a prioridade máxima é o backend go"): the transcription is put together in Go as the app does it in the browser
// (src/lib/transcription/align.ts and turns.ts). These are the same cases as src/test/transcription/align.test.ts and turns.test.ts:
// the same input gives the same transcription on both sides.

func word(start, end float64, text string) Word { return Word{Start: start, End: end, Text: text} }
func turn(start, end float64, speaker string) Turn {
	return Turn{Start: start, End: end, Speaker: speaker}
}

func texts(words []Word) []string {
	out := []string{}
	for _, w := range words {
		out = append(out, w.Text)
	}
	return out
}

func TestAlignKeepsTheBetterWordsOnTheTimesOfWhisper(t *testing.T) {
	timed := []Word{word(101, 101.4, "Calcular"), word(101.4, 101.8, "para"), word(101.8, 102.1, "o"), word(102.1, 102.6, "assolo"), word(102.6, 103, "por"), word(103, 103.3, "mês")}
	words := AlignWords(timed, "Calcular pro soluto por mês.", 100, 400)
	if got := texts(words); !reflect.DeepEqual(got, []string{"Calcular", "pro", "soluto", "por", "mês."}) {
		t.Fatalf("%v", got)
	}
	if words[0].Start != 101 || words[0].End != 101.4 || words[3].Start != 102.6 || words[3].End != 103 || words[4].Start != 103 || words[4].End != 103.3 {
		t.Fatalf("times %v", words)
	}
	for i := 1; i < len(words); i++ {
		if words[i].Start < words[i-1].Start {
			t.Fatalf("out of order %v", words)
		}
	}
}

func TestAlignDropsWhatOnlyWhisperHeardInTheSilence(t *testing.T) {
	timed := []Word{word(4, 4.5, "Tchau."), word(9, 9.5, "Obrigado."), word(34.4, 34.8, "Pode"), word(34.8, 35, "ir,"), word(35, 35.3, "Reg?")}
	if got := texts(AlignWords(timed, "Pode ir, Reg?", 0, 300)); !reflect.DeepEqual(got, []string{"Pode", "ir,", "Reg?"}) {
		t.Fatalf("%v", got)
	}
}

func TestAlignKeepsALongStretchButNotARepeatedOne(t *testing.T) {
	kept := []Word{word(10, 10.3, "aí"), word(10.3, 10.6, "você"), word(10.6, 10.9, "pega"), word(10.9, 11.2, "o"), word(11.2, 11.6, "período"), word(11.6, 12, "menor")}
	repeated := []Word{word(20, 20.2, "E"), word(20.2, 20.4, "aí"), word(20.4, 20.6, "E"), word(20.6, 20.8, "aí"), word(20.8, 21, "E"), word(21, 21.2, "aí")}
	timed := append(append(append([]Word{word(1, 1.4, "Bom"), word(1.4, 1.8, "dia")}, kept...), repeated...), word(30, 30.4, "Até"), word(30.4, 30.8, "logo"))
	want := []string{"Bom", "dia.", "aí", "você", "pega", "o", "período", "menor", "Até", "logo."}
	if got := texts(AlignWords(timed, "Bom dia. Até logo.", 0, 300)); !reflect.DeepEqual(got, want) {
		t.Fatalf("%v", got)
	}
}

func TestAlignAWordOnlyTheTextHeardComesRightAfterThePreviousOne(t *testing.T) {
	words := AlignWords([]Word{word(50, 50.4, "Tem"), word(60, 60.4, "rápida")}, "Tem que fazer essa coisa rápida", 0, 300)
	if got := texts(words); !reflect.DeepEqual(got, []string{"Tem", "que", "fazer", "essa", "coisa", "rápida"}) {
		t.Fatalf("%v", got)
	}
	if words[1].Start != 50.4 || math.Abs(words[1].End-50.75) > 1e-9 || words[4].End > 60 {
		t.Fatalf("%v", words)
	}
}

func TestAlignWithoutTheTextKeepsTheTimedWords(t *testing.T) {
	timed := []Word{word(1, 2, "oi")}
	if got := AlignWords(timed, "  ", 0, 300); !reflect.DeepEqual(got, timed) {
		t.Fatalf("%v", got)
	}
}

func TestBlocksCutWhereTheSpeakerChanges(t *testing.T) {
	words := []Word{word(2, 2.4, "Quanto"), word(2.4, 2.9, "custou"), word(2.9, 3.3, "isso?"), word(4.1, 4.5, "Custou"), word(4.5, 5, "dois"), word(5, 5.6, "mil.")}
	got := BlocksFromWords(words, []Turn{turn(1.8, 3.6, "speaker_0"), turn(3.9, 6, "speaker_1")}, nil)
	want := []Block{{Speaker: "speaker_0", Start: 2, End: 3.3, Text: "Quanto custou isso?"}, {Speaker: "speaker_1", Start: 4.1, End: 5.6, Text: "Custou dois mil."}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%v", got)
	}
}

func speakersAndTexts(blocks []Block) [][2]string {
	out := [][2]string{}
	for _, b := range blocks {
		out = append(out, [2]string{b.Speaker, b.Text})
	}
	return out
}

func TestBlocksAWordGoesToWhomItOverlapsMostOrTheNearest(t *testing.T) {
	got := speakersAndTexts(BlocksFromWords([]Word{word(0, 1, "oi"), word(1.8, 2.6, "tudo"), word(2.6, 3, "bem")}, []Turn{turn(0, 2, "a"), turn(2, 3, "b")}, nil))
	if !reflect.DeepEqual(got, [][2]string{{"a", "oi"}, {"b", "tudo bem"}}) {
		t.Fatalf("overlap %v", got)
	}
	got = speakersAndTexts(BlocksFromWords([]Word{word(0, 0.4, "então"), word(5, 5.5, "certo"), word(9.2, 9.6, "isso")}, []Turn{turn(4, 6, "a"), turn(9.8, 12, "b")}, nil))
	if !reflect.DeepEqual(got, [][2]string{{"a", "então certo"}, {"b", "isso"}}) {
		t.Fatalf("nearest %v", got)
	}
}

func TestBlocksTheSameSpeakerComingBackOpensANewBlock(t *testing.T) {
	blocks := BlocksFromWords([]Word{word(0, 1, "um"), word(2, 3, "dois"), word(4, 5, "três")}, []Turn{turn(0, 1.5, "a"), turn(1.5, 3.5, "b"), turn(3.5, 6, "a")}, nil)
	if len(blocks) != 3 || blocks[0].Speaker != "a" || blocks[1].Speaker != "b" || blocks[2] != (Block{Speaker: "a", Start: 4, End: 5, Text: "três"}) {
		t.Fatalf("%v", blocks)
	}
}

func TestBlocksWithoutTurnsAndEmptyWords(t *testing.T) {
	if got := BlocksFromWords([]Word{word(0, 1, "sem"), word(1, 2, "falantes")}, nil, nil); !reflect.DeepEqual(got, []Block{{Speaker: "", Start: 0, End: 2, Text: "sem falantes"}}) {
		t.Fatalf("no turns %v", got)
	}
	if got := BlocksFromWords([]Word{word(0, 1, " "), word(1, 2, "fala")}, []Turn{turn(0, 3, "a")}, nil); !reflect.DeepEqual(got, []Block{{Speaker: "a", Start: 1, End: 2, Text: "fala"}}) {
		t.Fatalf("empty %v", got)
	}
}

func TestWordsInSpeechDropsWhatWhisperInventsInTheSilence(t *testing.T) {
	words := []Word{word(4, 4.6, "Tchau."), word(34.4, 34.8, "Pode"), word(34.8, 35.1, "ir?"), word(38.2, 38.7, "Obrigado."), word(41.9, 42.3, "É"), word(44.9, 45.6, "isso.")}
	if got := texts(WordsInSpeech(words, []Turn{turn(34.4, 35.2, "a"), turn(41.8, 44.4, "b"), turn(44.8, 45.1, "b")})); !reflect.DeepEqual(got, []string{"Pode", "ir?", "É", "isso."}) {
		t.Fatalf("%v", got)
	}
	if got := WordsInSpeech(words[:2], nil); !reflect.DeepEqual(got, words[:2]) {
		t.Fatalf("without turns %v", got)
	}
}

func TestASentenceStaysWithWhoSaidMostOfIt(t *testing.T) {
	words := []Word{word(1, 1.3, "Essa"), word(1.3, 1.6, "aí"), word(1.6, 1.9, "eu"), word(1.9, 2.3, "entendi,"), word(2.3, 2.6, "é"), word(2.6, 2.8, "só"), word(2.8, 3.1, "arrumar"), word(3.1, 3.3, "o"), word(3.3, 3.6, "campo"), word(3.7, 4, "ali.")}
	if got := speakersAndTexts(BlocksFromWords(words, []Turn{turn(0.9, 3.65, "a"), turn(3.65, 4.2, "b")}, nil)); !reflect.DeepEqual(got, [][2]string{{"a", "Essa aí eu entendi, é só arrumar o campo ali."}}) {
		t.Fatalf("slip %v", got)
	}
	long := []Word{word(1, 1.3, "um"), word(1.3, 1.6, "dois"), word(1.6, 1.9, "três"), word(2, 2.3, "quatro"), word(2.3, 2.6, "cinco"), word(2.6, 2.9, "seis"), word(3, 3.3, "sete"), word(3.3, 3.6, "oito.")}
	blocks := BlocksFromWords(long, []Turn{turn(0.9, 1.95, "a"), turn(1.95, 3.7, "b")}, nil)
	if len(blocks) != 2 || blocks[0].Speaker != "a" || blocks[1].Speaker != "b" {
		t.Fatalf("real change %v", blocks)
	}
}

// The microphone by the volume the recording kept (src/test/recording/volume-envelope.test.ts): the recorder's words are "mic".
func TestTheMicrophoneByTheVolumeOfEachChannel(t *testing.T) {
	// 20 s, windows of 50 ms: the microphone loud in 2-6 s and 14-16 s, the computer in 8-12 s (and soft in 14-16 s)
	volumes := Volumes{Step: 0.05}
	for at := 0.0; at < 20; at += 0.05 {
		mic, computer := float32(0.0006), float32(0.0006)
		if (at >= 2 && at < 6) || (at >= 14 && at < 16) {
			mic = 0.21
		}
		if at >= 8 && at < 12 {
			computer = 0.18
		} else if at >= 14 && at < 16 {
			computer = 0.035
		}
		volumes.Microphone = append(volumes.Microphone, mic)
		volumes.Computer = append(volumes.Computer, computer)
	}
	words := []Word{word(2.5, 3, "microfone"), word(9, 9.4, "computador"), word(14.5, 15, "juntos"), word(18, 18.5, "silêncio")}
	mic, computer := volumes.Tests()
	gotMic, gotComputer := []bool{}, []bool{}
	for _, w := range words {
		gotMic = append(gotMic, mic(w))
		gotComputer = append(gotComputer, computer(w))
	}
	if !reflect.DeepEqual(gotMic, []bool{true, false, true, false}) || !reflect.DeepEqual(gotComputer, []bool{false, true, false, false}) {
		t.Fatalf("mic %v computer %v", gotMic, gotComputer)
	}
	// the part `volume` as the recording keeps it: one byte a window on a decibel scale
	part, err := VolumesOfPart(`{"step":0.05,"microphone":"AP8=","computer":"/wA="}`)
	if err != nil || part.Step != 0.05 || len(part.Microphone) != 2 || part.Microphone[0] != 0 || part.Microphone[1] < 0.99 || part.Computer[0] < 0.99 {
		t.Fatalf("part %+v %v", part, err)
	}
}

func TestSpeakersNamesAndTheTextOfTheNote(t *testing.T) {
	blocks := []Block{{Speaker: "mic", Start: 1, End: 3, Text: "Bom dia."}, {Speaker: "speaker_1", Start: 65, End: 70, Text: "Oi."}, {Speaker: "speaker_0", Start: 3725, End: 3730, Text: "Tchau."}}
	speakers := SpeakersOf(blocks, "")
	if !reflect.DeepEqual(speakers, []Speaker{{ID: "mic", Name: "Quem gravou"}, {ID: "speaker_1", Name: "Falante 2"}, {ID: "speaker_0", Name: "Falante 3"}}) {
		t.Fatalf("%v", speakers)
	}
	if got := SpeakersOf(blocks, "Ana")[0].Name; got != "Ana" {
		t.Fatalf("recorder %q", got)
	}
	want := "Quem gravou [00:01]: Bom dia.\nFalante 2 [01:05]: Oi.\nFalante 3 [1:02:05]: Tchau.\n"
	if got := TranscriptText(blocks, speakers); got != want {
		t.Fatalf("%q", got)
	}
	if got := TranscriptText([]Block{{Start: 5, End: 6, Text: "sem falantes"}}, nil); got != "[00:05] sem falantes\n" {
		t.Fatalf("%q", got)
	}
}
