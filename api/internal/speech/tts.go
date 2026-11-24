package speech

import (
	"bytes"
	"context"
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"io"
	"os/exec"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/regyeduardo/study-helper/api/internal/ai"
	"github.com/regyeduardo/study-helper/api/internal/blobs"
)

// T036: the model voice (POST /v1/speech/tts). The same sentence, voice and language is the same file in R2 (lang/tts/<sha1>.mp3),
// with no data of the person; each audio starts with ~400 ms of silence, because a Bluetooth headset or the sound output waking up cut the
// first word (prototype).

// MaxChars is the longest sentence the voice says.
const MaxChars = 500

// ErrInvalidText is an empty or too long sentence.
var ErrInvalidText = errors.New("invalid_text")

// Speaker is the AI that speaks (ai.Client in the server).
type Speaker interface {
	Speech(ctx context.Context, model ai.Model, text, voice, lang string) ([]byte, error)
}

// TTS says sentences with the model voice.
type TTS struct {
	AI    Speaker
	Blobs blobs.Store
	// LeadIn puts the silence before the speech (ffmpeg when nil)
	LeadIn func([]byte) []byte
}

// kokoroVoices are the English voices by accent; the first is the default.
var kokoroVoices = map[string]string{"en-US": "af_heart", "en-GB": "bf_emma"}

// Voice is the model and the voice for a locale (en-US, es-ES…).
func Voice(locale, voice string) (ai.Model, string, string) {
	lang := strings.ToLower(strings.SplitN(locale, "-", 2)[0])
	model, _ := ai.ModelFor("idiomas-voz", lang)
	if voice == "" {
		if lang == "en" {
			voice = kokoroVoices[locale]
			if voice == "" {
				voice = kokoroVoices["en-US"]
			}
		} else {
			voice = "default"
		}
	}
	return model, voice, lang
}

// Key is where an audio is kept.
func Key(model, voice, locale, text string) string {
	sum := sha1.Sum([]byte(model + "|" + voice + "|" + locale + "|" + text + "|lead400"))
	return "lang/tts/" + hex.EncodeToString(sum[:]) + ".mp3"
}

// Say is the audio of the sentence, from the cache or the voice.
func (t *TTS) Say(ctx context.Context, text, locale, voice string) ([]byte, error) {
	text = strings.TrimSpace(text)
	if text == "" || utf8.RuneCountInString(text) > MaxChars {
		return nil, ErrInvalidText
	}
	model, voice, lang := Voice(locale, voice)
	key := Key(model.ID, voice, locale, text)
	if t.Blobs != nil {
		if reader, _, err := t.Blobs.Get(ctx, key, nil); err == nil {
			audio, readErr := io.ReadAll(reader)
			reader.Close()
			if readErr == nil && len(audio) > 0 {
				return audio, nil
			}
		}
	}
	audio, err := t.AI.Speech(ctx, model, text, voice, lang)
	if err != nil {
		return nil, err
	}
	lead := t.LeadIn
	if lead == nil {
		lead = LeadIn
	}
	audio = lead(audio)
	if t.Blobs != nil {
		_ = t.Blobs.Put(ctx, key, audio, "audio/mpeg", nil)
	}
	return audio, nil
}

// LeadIn is the mp3 with 400 ms of silence before; when ffmpeg cannot do it, the audio goes as it came.
func LeadIn(mp3 []byte) []byte {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "ffmpeg", "-loglevel", "error", "-i", "pipe:0", "-af", "adelay=400:all=1", "-f", "mp3", "pipe:1")
	cmd.Stdin = bytes.NewReader(mp3)
	out, err := cmd.Output()
	if err != nil || len(out) == 0 {
		return mp3
	}
	return out
}
