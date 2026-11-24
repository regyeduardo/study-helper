package ai

import "testing"

// T005 (spec 004): each use of the languages mode calls the model of the fixed list (src/lib/ai/recommendations.ts, LANGUAGE_RECOMMENDATIONS).
func TestLanguageUsesFollowTheFixedList(t *testing.T) {
	cases := map[string]Model{
		"idiomas-gerar":   {Provider: "deepinfra", ID: "deepseek-ai/DeepSeek-V4-Flash-0731"},
		"idiomas-fala":    {Provider: "deepinfra", ID: "openai/whisper-large-v3"},
		"idiomas-ouvinte": {Provider: "openrouter", ID: "google/gemini-3-flash-preview"},
		"idiomas-fonemas": {Provider: "servidor", ID: "facebook/wav2vec2-xlsr-53-espeak-cv-ft"},
	}
	for use, want := range cases {
		if got, ok := ModelFor(use, "en"); !ok || got != want {
			t.Fatalf("%s: %+v %v", use, got, ok)
		}
	}
	// the model voice: Kokoro in English, Chatterbox in the other languages
	if got, _ := ModelFor("idiomas-voz", "en"); got.ID != "hexgrad/Kokoro-82M" {
		t.Fatalf("voice en: %+v", got)
	}
	if got, _ := ModelFor("idiomas-voz", "es"); got.ID != "ResembleAI/chatterbox-multilingual" {
		t.Fatalf("voice es: %+v", got)
	}
	// the fallbacks, in order, when the first does not answer
	if ladder := Ladder("idiomas-fala"); len(ladder) != 1 || ladder[0].ID != "mistralai/Voxtral-Small-24B-2507" {
		t.Fatalf("ladder: %+v", ladder)
	}
	if _, ok := ModelFor("nada", "en"); ok {
		t.Fatal("an unknown use has no model")
	}
}
