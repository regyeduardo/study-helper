package speech

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/regyeduardo/study-helper/api/internal/ai"
	"github.com/regyeduardo/study-helper/api/internal/blobs"
)

// T035: the model voice. Cached by text, voice and language; ~400 ms of silence before the speech; Kokoro in English, Chatterbox in the others.

type fakeVoice struct {
	calls []string
	fail  error
}

func (f *fakeVoice) Speech(_ context.Context, model ai.Model, text, voice, lang string) ([]byte, error) {
	f.calls = append(f.calls, model.ID+"|"+voice+"|"+lang+"|"+text)
	if f.fail != nil {
		return nil, f.fail
	}
	return []byte("mp3:" + text), nil
}

func TestSayCachesAndPicksTheVoice(t *testing.T) {
	voice := &fakeVoice{}
	store := blobs.NewMemory()
	tts := &TTS{AI: voice, Blobs: store, LeadIn: func(mp3 []byte) []byte { return append([]byte("silence+"), mp3...) }}
	ctx := context.Background()
	audio, err := tts.Say(ctx, "  The long road ", "en-US", "")
	if err != nil || string(audio) != "silence+mp3:The long road" {
		t.Fatalf("first: %q %v", audio, err)
	}
	again, _ := tts.Say(ctx, "The long road", "en-US", "")
	if string(again) != string(audio) || len(voice.calls) != 1 {
		t.Fatalf("the same sentence comes from the cache: %v", voice.calls)
	}
	if !strings.HasPrefix(voice.calls[0], "hexgrad/Kokoro-82M|af_heart|en|") {
		t.Fatalf("Kokoro in English: %v", voice.calls)
	}
	_, _ = tts.Say(ctx, "The long road", "en-GB", "")
	_, _ = tts.Say(ctx, "The long road", "en-US", "am_michael")
	_, _ = tts.Say(ctx, "El camino largo", "es-ES", "")
	if len(voice.calls) != 4 || !strings.HasPrefix(voice.calls[1], "hexgrad/Kokoro-82M|bf_emma|en|") || !strings.HasPrefix(voice.calls[3], "ResembleAI/chatterbox-multilingual|default|es|") {
		t.Fatalf("each voice and language its own audio: %v", voice.calls)
	}
	if _, err := store.Head(ctx, Key("hexgrad/Kokoro-82M", "af_heart", "en-US", "The long road")); err != nil || !strings.HasPrefix(Key("m", "v", "l", "t"), "lang/tts/") {
		t.Fatalf("kept in lang/tts/: %v", err)
	}
	for _, text := range []string{"", "   ", strings.Repeat("a", MaxChars+1)} {
		if _, err := tts.Say(ctx, text, "en-US", ""); !errors.Is(err, ErrInvalidText) {
			t.Fatalf("%d chars: %v", len(text), err)
		}
	}
}

func TestSayProviderDown(t *testing.T) {
	tts := &TTS{AI: &fakeVoice{fail: ai.ErrProviderDown}, LeadIn: func(b []byte) []byte { return b }}
	if _, err := tts.Say(context.Background(), "Hello", "en-US", ""); !errors.Is(err, ai.ErrProviderDown) {
		t.Fatalf("down: %v", err)
	}
}

func duration(t *testing.T, mp3 []byte) float64 {
	t.Helper()
	path := filepath.Join(t.TempDir(), "a.mp3")
	if err := os.WriteFile(path, mp3, 0o600); err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command("ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path).Output()
	if err != nil {
		t.Fatal(err)
	}
	seconds, _ := strconv.ParseFloat(strings.TrimSpace(string(out)), 64)
	return seconds
}

func TestLeadInAddsSilenceBefore(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("no ffmpeg here (the server image has it)")
	}
	tone, err := exec.Command("ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1:sample_rate=24000", "-f", "mp3", "pipe:1").Output()
	if err != nil {
		t.Fatal(err)
	}
	before, after := duration(t, tone), duration(t, LeadIn(tone))
	if gain := after - before; gain < 0.35 || gain > 0.5 {
		t.Fatalf("~400 ms more: %.3f → %.3f", before, after)
	}
	if got := LeadIn([]byte("not audio")); string(got) != "not audio" {
		t.Fatal("what ffmpeg cannot read goes as it came")
	}
}
