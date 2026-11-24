package ai

// Model is one model of a provider: where it runs (deepinfra, openrouter, or "servidor" for the phoneme service) and its id.
type Model struct {
	Provider string
	ID       string
}

// languageModels is the fixed list of the languages mode (spec 004, FR-034), the same as LANGUAGE_RECOMMENDATIONS in
// src/lib/ai/recommendations.ts: the indicated model first, then the others in order.
var languageModels = map[string][]Model{
	"idiomas-gerar":   {{"deepinfra", "deepseek-ai/DeepSeek-V4-Flash-0731"}, {"openrouter", "openai/gpt-6-luna"}},
	"idiomas-fala":    {{"deepinfra", "openai/whisper-large-v3"}, {"deepinfra", "mistralai/Voxtral-Small-24B-2507"}},
	"idiomas-ouvinte": {{"openrouter", "google/gemini-3-flash-preview"}},
	"idiomas-fonemas": {{"servidor", "facebook/wav2vec2-xlsr-53-espeak-cv-ft"}},
}

// the model voice: Kokoro speaks English natively; Chatterbox the other languages
var (
	englishVoice = Model{"deepinfra", "hexgrad/Kokoro-82M"}
	otherVoice   = Model{"deepinfra", "ResembleAI/chatterbox-multilingual"}
)

// ModelFor is the model a use of the languages mode calls for a language (an ISO code: en, es, fr…).
func ModelFor(use, lang string) (Model, bool) {
	if use == "idiomas-voz" {
		if lang == "en" {
			return englishVoice, true
		}
		return otherVoice, true
	}
	models, ok := languageModels[use]
	if !ok || len(models) == 0 {
		return Model{}, false
	}
	return models[0], true
}

// Ladder is the next models of a use, in order, for when the first does not answer.
func Ladder(use string) []Model {
	models := languageModels[use]
	if len(models) < 2 {
		return nil
	}
	return append([]Model(nil), models[1:]...)
}
