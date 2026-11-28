package transcribe

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Config is how a transcription is made in the server. The zero values are the decisions of research R28 and R29.
type Config struct {
	FFmpeg string
	// Keys are the server's keys ("deepinfra", "openrouter"); Origins replace the providers' addresses (tests).
	Keys    map[string]string
	Origins map[string]string
	HTTP    *http.Client
	// Language of the recording ("pt"), the person's terms (they go to the listener as context, never to Whisper), who recorded.
	Language string
	Terms    string
	Recorder string
	// TimesModel gives the time of each word (DeepInfra, /audio/transcriptions); Listener writes the text of each part (OpenRouter,
	// chat/completions with input_audio); "-" for none.
	TimesModel string
	Listener   string
	// PartSeconds is the length of each part (180: 3 min, R28).
	PartSeconds int
	// LateMin is the floor of the late-part rule: a part still unanswered after max(2 x the median of the answered ones, LateMin) is
	// asked again, and the first answer wins (T200; 20 s).
	LateMin time.Duration
	// The listener has, after Whisper answered its part, max(TextGraceMin, PartSeconds x TextGracePerSecond) (T198: 30 s, 0.45).
	TextGraceMin       time.Duration
	TextGracePerSecond float64
	// Retries is how many times a request that failed (5xx, 429, network) is tried (4).
	Retries int
	// Progress says the stage and, when counted, how many of how many parts.
	Progress func(stage string, done, total int)
}

// Stage is how long a step of the transcription took (the "Etapas" of the note).
type Stage struct {
	Name string `json:"name"`
	MS   int64  `json:"ms"`
}

// Result is the transcription as the note keeps it, and what it cost (US$).
type Result struct {
	Blocks   []Block
	Speakers []Speaker
	Text     string
	Warning  string
	Cost     float64
	Duration float64
	Stages   []Stage
}

const (
	defaultTimesModel = "openai/whisper-large-v3-turbo"
	defaultListener   = "qwen/qwen3.8-omni-flash"
	noSpeakers        = "Este modelo de transcrição não separa quem fala."
	lateFactor        = 2
)

var defaultOrigins = map[string]string{
	"deepinfra": "https://api.deepinfra.com", "openrouter": "https://openrouter.ai", "vercel": "https://ai-gateway.vercel.sh", "deepseek": "https://api.deepseek.com",
	"xai": "https://api.x.ai", "mistral": "https://api.mistral.ai", "openai": "https://api.openai.com", "gemini": "https://generativelanguage.googleapis.com",
	"groq": "https://api.groq.com", "together": "https://api.together.xyz",
}

// hourly is the price per hour of audio of the speech models (src/lib/ai/recommendations.ts), for a service that does not say it.
var hourly = map[string]float64{"openai/whisper-large-v3-turbo": 0.012, "openai/whisper-large-v3": 0.027, "mistralai/Voxtral-Small-24B-2507": 0.18}

func (c Config) withDefaults() Config {
	if c.FFmpeg == "" {
		c.FFmpeg = "ffmpeg"
	}
	if c.TimesModel == "" {
		c.TimesModel = defaultTimesModel
	}
	if c.Listener == "" {
		c.Listener = defaultListener
	}
	if c.PartSeconds <= 0 {
		c.PartSeconds = 180
	}
	if c.LateMin <= 0 {
		c.LateMin = 20 * time.Second
	}
	if c.TextGraceMin <= 0 {
		c.TextGraceMin = 30 * time.Second
	}
	if c.TextGracePerSecond <= 0 {
		c.TextGracePerSecond = 0.45
	}
	if c.Retries <= 0 {
		c.Retries = 4
	}
	if c.HTTP == nil {
		c.HTTP = &http.Client{}
	}
	if c.Progress == nil {
		c.Progress = func(string, int, int) {}
	}
	return c
}

func (c Config) origin(provider string) string {
	if origin, ok := c.Origins[provider]; ok {
		return strings.TrimRight(origin, "/")
	}
	return defaultOrigins[provider]
}

// spending adds up what the transcription cost, from parts heard at once.
type spending struct {
	mu  sync.Mutex
	usd float64
}

func (s *spending) add(usd float64) {
	s.mu.Lock()
	s.usd += usd
	s.mu.Unlock()
}

// ListenerInstruction is what the listener is asked for each part (src/lib/transcription/types.ts, listenerInstruction).
func ListenerInstruction(language, terms string) string {
	spoken := "no idioma em que é falado"
	if language == "" || strings.HasPrefix(language, "pt") {
		spoken = "em português do Brasil"
	}
	list := []string{}
	for _, term := range strings.FieldsFunc(terms, func(r rune) bool { return r == '\n' || r == ',' || r == ';' }) {
		if term = strings.TrimSpace(term); term != "" {
			list = append(list, term)
		}
	}
	known := ""
	if len(list) > 0 {
		known = " Se forem ditos, escreva estes termos assim: " + strings.Join(list, ", ") + "."
	}
	return "Transcreva exatamente o que é dito neste áudio, " + spoken + ", palavra por palavra, do começo ao fim, sem resumir, sem traduzir, sem nomes de quem fala e sem comentários. Responda só com o texto falado." + known
}

// Run transcribes the recording at `media` (a file on disk), with the volume of each channel the recording kept (nil: none), working in
// `workdir` (removed by the caller).
func Run(ctx context.Context, cfg Config, media string, volumes *Volumes, workdir string) (Result, error) {
	cfg = cfg.withDefaults()
	stages := []Stage{}
	since := func(name string, started time.Time) {
		stages = append(stages, Stage{Name: name, MS: time.Since(started).Milliseconds()})
	}
	cfg.Progress("Cortando o áudio", 0, 0)
	started := time.Now()
	cut, err := Cut(ctx, cfg.FFmpeg, media, workdir, cfg.PartSeconds)
	if err != nil {
		return Result{}, err
	}
	since("Cortar o áudio", started)

	spent := &spending{}
	// the voices are split beside the parts, over the whole audio as it is (R29)
	type splitting struct {
		turns []Turn
		err   error
	}
	split := make(chan splitting, 1)
	splitCtx, stopSplit := context.WithCancel(ctx)
	defer stopSplit()
	go func() {
		turns, err := cfg.splitVoices(splitCtx, cut, spent)
		split <- splitting{turns, err}
	}()

	started = time.Now()
	heard, err := cfg.hearParts(ctx, cut, spent)
	if err != nil {
		return Result{}, err
	}
	since("Enviar e transcrever", started)
	cfg.Progress("Separando quem fala", 0, 0)
	started = time.Now()
	voices := <-split
	since("Separar quem fala", started)

	words := []Word{}
	for k, part := range cut.Parts {
		times := heard[k].times
		spoken := WordsInSpeech(times, voices.turns)
		base := times
		if len(spoken)*2 >= len(times) {
			base = spoken
		}
		words = append(words, AlignWords(base, heard[k].text, part.Start, part.Start+float64(cfg.PartSeconds))...)
	}
	blocks := BlocksFromWords(words, voices.turns, volumes)
	speakers := SpeakersOf(blocks, cfg.Recorder)
	warning := ""
	if len(voices.turns) == 0 {
		warning = noSpeakers
		if voices.err != nil {
			warning = "Os falantes não foram separados: " + voices.err.Error()
		}
	}
	return Result{Blocks: blocks, Speakers: speakers, Text: strings.TrimSpace(TranscriptText(blocks, speakers)), Warning: warning, Cost: spent.usd, Duration: cut.Duration, Stages: stages}, nil
}

type heardPart struct {
	times []Word
	text  string
}

// hearParts sends every part at once; the late one is asked again (T200).
func (c Config) hearParts(ctx context.Context, cut Cutting, spent *spending) ([]heardPart, error) {
	ctx, stop := context.WithCancel(ctx)
	defer stop()
	total := len(cut.Parts)
	results := make([]heardPart, total)
	var mu sync.Mutex
	took := []time.Duration{}
	done := 0
	lateAfter := func() (time.Duration, bool) {
		mu.Lock()
		defer mu.Unlock()
		if len(took) == 0 {
			return 0, false
		}
		sorted := append([]time.Duration(nil), took...)
		sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
		return max(lateFactor*sorted[len(sorted)/2], c.LateMin), true
	}
	c.Progress("Transcrevendo", 0, total)
	failures := make(chan error, total)
	var wg sync.WaitGroup
	for k := range cut.Parts {
		wg.Add(1)
		go func(k int) {
			defer wg.Done()
			started := time.Now()
			heard, err := c.racePart(ctx, cut, k, lateAfter, spent)
			if err != nil {
				failures <- err
				stop()
				return
			}
			mu.Lock()
			results[k] = heard
			took = append(took, time.Since(started))
			done++
			c.Progress("Transcrevendo", done, total)
			mu.Unlock()
		}(k)
	}
	wg.Wait()
	close(failures)
	if err := <-failures; err != nil {
		return nil, err
	}
	return results, nil
}

// racePart hears one part; when it is late (lateAfter), it is asked once more and the first answer wins.
func (c Config) racePart(ctx context.Context, cut Cutting, k int, lateAfter func() (time.Duration, bool), spent *spending) (heardPart, error) {
	type answer struct {
		heard heardPart
		err   error
		which int
	}
	answers := make(chan answer, 2)
	cancels := []context.CancelFunc{}
	launch := func() {
		attemptCtx, cancel := context.WithCancel(ctx)
		which := len(cancels)
		cancels = append(cancels, cancel)
		go func() {
			heard, err := c.hearPart(attemptCtx, cut, k, spent)
			answers <- answer{heard, err, which}
		}()
	}
	defer func() {
		for _, cancel := range cancels {
			cancel()
		}
	}()
	started := time.Now()
	launch()
	check := time.NewTicker(min(time.Second, max(c.LateMin/4, 10*time.Millisecond)))
	defer check.Stop()
	failed := 0
	var firstErr error
	for {
		select {
		case got := <-answers:
			if got.err == nil {
				return got.heard, nil
			}
			if firstErr == nil {
				firstErr = got.err
			}
			if failed++; failed == len(cancels) {
				return heardPart{}, firstErr
			}
		case <-check.C:
			if len(cancels) > 1 {
				continue
			}
			if limit, ok := lateAfter(); ok && time.Since(started) >= limit {
				launch()
			}
		case <-ctx.Done():
			return heardPart{}, ctx.Err()
		}
	}
}

// hearPart: the times of each word by Whisper and, beside it, the text by the listener, which has a grace after Whisper answered (T198).
func (c Config) hearPart(ctx context.Context, cut Cutting, k int, spent *spending) (heardPart, error) {
	part := cut.Parts[k]
	texts := make(chan string, 1)
	listenCtx, stopListening := context.WithCancel(ctx)
	defer stopListening()
	if c.Listener != "-" && c.Keys["openrouter"] != "" {
		go func() {
			text, err := c.listen(listenCtx, part, cut.Format, spent)
			if err != nil {
				text = ""
			}
			texts <- text
		}()
	} else {
		texts <- ""
	}
	times, err := c.whisper(ctx, part, k, len(cut.Parts), spent)
	if err != nil {
		return heardPart{}, err
	}
	grace := max(c.TextGraceMin, time.Duration(float64(c.PartSeconds)*c.TextGracePerSecond*float64(time.Second)))
	timer := time.NewTimer(grace)
	defer timer.Stop()
	select {
	case text := <-texts:
		return heardPart{times, text}, nil
	case <-timer.C:
		return heardPart{times, ""}, nil
	case <-ctx.Done():
		return heardPart{}, ctx.Err()
	}
}

// errRetry is a failure worth trying again (the provider's 5xx or 429, the network).
type errRetry struct{ error }

// post sends a request built by `body` (a fresh body for each try), with a limit for each try, trying again what is worth it.
func (c Config) post(ctx context.Context, url, key, contentType string, limit time.Duration, body func() (io.Reader, string), who string) ([]byte, error) {
	var last error
	for attempt := 0; attempt < c.Retries; attempt++ {
		if attempt > 0 {
			select {
			case <-time.After(time.Duration(1<<attempt) * time.Second):
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		tryCtx, cancel := context.WithTimeout(ctx, limit)
		reader, kind := body()
		if kind == "" {
			kind = contentType
		}
		request, err := http.NewRequestWithContext(tryCtx, http.MethodPost, url, reader)
		if err != nil {
			cancel()
			return nil, err
		}
		request.Header.Set("Authorization", "Bearer "+key)
		request.Header.Set("Content-Type", kind)
		response, err := c.HTTP.Do(request)
		if err != nil {
			cancel()
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			last = errRetry{fmt.Errorf("%s não respondeu", who)}
			continue
		}
		out, readErr := io.ReadAll(io.LimitReader(response.Body, 32<<20))
		response.Body.Close()
		cancel()
		switch {
		case readErr != nil:
			last = errRetry{fmt.Errorf("%s não respondeu", who)}
			continue
		case response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= 500:
			last = errRetry{fmt.Errorf("%s está com erro no servidor (%d)", who, response.StatusCode)}
			continue
		case response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden:
			return nil, fmt.Errorf("a chave %s foi recusada", who)
		case response.StatusCode >= 300:
			detail := strings.TrimSpace(string(out))
			if runes := []rune(detail); len(runes) > 300 {
				detail = string(runes[:300]) + "…"
			}
			return nil, &Refused{Who: who, Status: response.StatusCode, Detail: detail}
		}
		return out, nil
	}
	return nil, last
}

// formOf streams a multipart form: the fields, then the file read from disk (never whole in memory).
func formOf(fields [][2]string, field, path string) func() (io.Reader, string) {
	return func() (io.Reader, string) {
		reader, writer := io.Pipe()
		form := multipart.NewWriter(writer)
		go func() {
			err := func() error {
				for _, f := range fields {
					if err := form.WriteField(f[0], f[1]); err != nil {
						return err
					}
				}
				file, err := os.Open(path)
				if err != nil {
					return err
				}
				defer file.Close()
				out, err := form.CreateFormFile(field, filepath.Base(path))
				if err != nil {
					return err
				}
				if _, err := io.Copy(out, file); err != nil {
					return err
				}
				return form.Close()
			}()
			writer.CloseWithError(err)
		}()
		return reader, form.FormDataContentType()
	}
}

func audioLimit(seconds float64, perMinute float64) time.Duration {
	return time.Duration((60 + perMinute*seconds/60) * float64(time.Second))
}

// whisper: the times of each word of one part (no prompt: the terms made Whisper skip what was said, R28).
func (c Config) whisper(ctx context.Context, part Part, k, total int, spent *spending) ([]Word, error) {
	key := c.Keys["deepinfra"]
	if key == "" {
		return nil, errors.New("falta a chave da DeepInfra no servidor")
	}
	fields := [][2]string{{"model", c.TimesModel}, {"response_format", "verbose_json"}, {"timestamp_granularities[]", "word"}, {"language", c.Language}}
	if c.Language == "" {
		fields[3][1] = "pt"
	}
	who := fmt.Sprintf("a DeepInfra (parte %d de %d)", k+1, total)
	raw, err := c.post(ctx, c.origin("deepinfra")+"/v1/openai/audio/transcriptions", key, "", audioLimit(part.End-part.Start, 30), formOf(fields, "file", part.Path), who)
	if err != nil {
		return nil, err
	}
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil, fmt.Errorf("%s respondeu algo que não é JSON", who)
	}
	if price, ok := hourly[c.TimesModel]; ok {
		seconds, _ := body["duration"].(float64)
		if seconds <= 0 {
			seconds = part.End - part.Start
		}
		spent.add(price * seconds / 3600)
	}
	return timedWords(body, part.Start), nil
}

// listen: the text of one part by the model that hears (OpenRouter), the part sent as base64 while it is read from disk.
func (c Config) listen(ctx context.Context, part Part, format string, spent *spending) (string, error) {
	instruction, _ := json.Marshal(ListenerInstruction(c.Language, c.Terms))
	model, _ := json.Marshal(c.Listener)
	body := func() (io.Reader, string) {
		reader, writer := io.Pipe()
		go func() {
			err := func() error {
				if _, err := io.WriteString(writer, `{"model":`+string(model)+`,"temperature":0,"reasoning":{"enabled":false},"messages":[{"role":"user","content":[{"type":"input_audio","input_audio":{"data":"`); err != nil {
					return err
				}
				file, err := os.Open(part.Path)
				if err != nil {
					return err
				}
				defer file.Close()
				encoder := base64.NewEncoder(base64.StdEncoding, writer)
				if _, err := io.Copy(encoder, file); err != nil {
					return err
				}
				if err := encoder.Close(); err != nil {
					return err
				}
				_, err = io.WriteString(writer, `","format":"`+format+`"}},{"type":"text","text":`+string(instruction)+`}]}]}`)
				return err
			}()
			writer.CloseWithError(err)
		}()
		return reader, "application/json"
	}
	raw, err := c.post(ctx, c.origin("openrouter")+"/api/v1/chat/completions", c.Keys["openrouter"], "application/json", audioLimit(part.End-part.Start, 30), body, "o modelo que ouve")
	if err != nil {
		return "", err
	}
	var answer struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Usage struct {
			Cost *float64 `json:"cost"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(raw, &answer); err != nil || len(answer.Choices) == 0 {
		return "", errors.New("o modelo que ouve respondeu vazio")
	}
	if answer.Usage.Cost != nil {
		spent.add(*answer.Usage.Cost)
	}
	return answer.Choices[0].Message.Content, nil
}

// splitVoices: who speaks when, over the whole audio as it is (DeepInfra's Nemotron, R29); it waits 60 s plus 10 s a minute, twice.
func (c Config) splitVoices(ctx context.Context, cut Cutting, spent *spending) ([]Turn, error) {
	key := c.Keys["deepinfra"]
	if key == "" {
		return nil, errors.New("falta a chave da DeepInfra no servidor")
	}
	retries := c
	retries.Retries = min(c.Retries, 2)
	raw, err := retries.post(ctx, c.origin("deepinfra")+"/v1/inference/nvidia/Nemotron-3-Diarization", key, "", audioLimit(cut.Duration, 10), formOf(nil, "audio", cut.Whole), "a DeepInfra")
	if err != nil {
		return nil, err
	}
	var body struct {
		Segments []map[string]any `json:"speaker_segments"`
		Status   struct {
			Cost *float64 `json:"cost"`
		} `json:"inference_status"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil, errors.New("a DeepInfra respondeu algo que não é JSON")
	}
	if body.Status.Cost != nil {
		spent.add(*body.Status.Cost)
	}
	return turnsOf(body.Segments, 0), nil
}

func number(value any) (float64, bool) {
	switch v := value.(type) {
	case float64:
		return v, !math.IsNaN(v) && !math.IsInf(v, 0)
	case string:
		var out float64
		if _, err := fmt.Sscanf(v, "%g", &out); err == nil {
			return out, true
		}
	}
	return 0, false
}

func timedRow(row map[string]any, text any, offset float64) (Word, bool) {
	start, ok := number(row["start"])
	clean := ""
	if s, isText := text.(string); isText {
		clean = strings.TrimSpace(s)
	}
	if clean == "" || !ok {
		return Word{}, false
	}
	end, hasEnd := number(row["end"])
	if !hasEnd {
		end = start
	}
	return Word{Start: start + offset, End: end + offset, Text: clean}, true
}

func rowsOf(value any) []map[string]any {
	list, _ := value.([]any)
	out := []map[string]any{}
	for _, item := range list {
		if row, ok := item.(map[string]any); ok {
			out = append(out, row)
		}
	}
	return out
}

// timedWords: the words with their times, else the segments, else the whole text (providers/custom.ts).
func timedWords(body map[string]any, offset float64) []Word {
	words := []Word{}
	for _, row := range rowsOf(body["words"]) {
		text := row["word"]
		if text == nil {
			text = row["text"]
		}
		if w, ok := timedRow(row, text, offset); ok {
			words = append(words, w)
		}
	}
	if len(words) == 0 {
		for _, row := range rowsOf(body["segments"]) {
			if w, ok := timedRow(row, row["text"], offset); ok {
				words = append(words, w)
			}
		}
	}
	if len(words) > 0 {
		return words
	}
	if text, _ := body["text"].(string); strings.TrimSpace(text) != "" {
		return []Word{{Start: offset, End: offset, Text: strings.TrimSpace(text)}}
	}
	return nil
}

// turnsOf: the stretches of each voice (providers/custom.ts).
func turnsOf(segments []map[string]any, offset float64) []Turn {
	out := []Turn{}
	for _, row := range segments {
		speaker := row["speaker"]
		if speaker == nil || speaker == "" {
			continue
		}
		start, ok := number(row["start"])
		if !ok {
			continue
		}
		end, hasEnd := number(row["end"])
		if !hasEnd {
			end = start
		}
		out = append(out, Turn{Start: start + offset, End: end + offset, Speaker: fmt.Sprint(speaker)})
	}
	return out
}

// ChatWith asks a text model of DeepInfra or OpenRouter (the system instruction and what the person sees), with the server's keys; what
// the provider says it cost goes to `spend` (may be nil).
func (c Config) ChatWith(provider, model string, spend func(float64)) Chat {
	ask := c.ChatLimit(provider, model, spend)
	return func(ctx context.Context, user, system string) (string, error) { return ask(ctx, user, system, 0) }
}

// ChatLimit is ChatWith with a limit of tokens for the answer (0: the app's 16384), as the generations ask (GenerationSession.chat).
func (c Config) ChatLimit(provider, model string, spend func(float64)) func(ctx context.Context, user, system string, maxTokens int) (string, error) {
	ask := c.Asker(provider, model, spend)
	return func(ctx context.Context, user, system string, maxTokens int) (string, error) {
		return ask(ctx, user, system, AskOptions{MaxTokens: maxTokens})
	}
}

// AskOptions are the knobs of one request to the AI.
type AskOptions struct {
	MaxTokens   int
	Temperature *float64
	// Extra fields of the request (the web search of OpenRouter: plugins); a nil value takes the field away (the temperature).
	Extra map[string]any
}

const (
	defaultMaxTokens   = 16384
	defaultTemperature = 0.7
)

// Asker asks the AI as the app does (src/controllers/ai.controller.ts, openAiChat): temperature 0.7, JSON mode when the instruction
// asks for JSON (never on DeepSeek, which may answer empty), and when the provider refuses the request (400, 422) it is asked again
// without the JSON mode, then without the limit of tokens.
func (c Config) Asker(provider, model string, spend func(float64)) func(ctx context.Context, user, system string, o AskOptions) (string, error) {
	ask := c.Measured(provider, model)
	return func(ctx context.Context, user, system string, o AskOptions) (string, error) {
		text, usage, err := ask(ctx, user, system, o)
		if err == nil && usage.Cost > 0 && spend != nil {
			spend(usage.Cost)
		}
		return text, err
	}
}

// Usage is what one answer took: the tokens (estimated by the letters when the provider does not say, as the app estimates) and the
// cost the provider said.
type Usage struct {
	Input, Output int
	Estimated     bool
	Cost          float64
}

// Measured is Asker that also gives back what each answer took.
func (c Config) Measured(provider, model string) func(ctx context.Context, user, system string, o AskOptions) (string, Usage, error) {
	c = c.withDefaults()
	return func(ctx context.Context, user, system string, o AskOptions) (string, Usage, error) {
		if err := c.Asks(provider); err != nil {
			return "", Usage{}, err
		}
		temperature := defaultTemperature
		if o.Temperature != nil {
			temperature = *o.Temperature
		}
		maxTokens := o.MaxTokens
		if maxTokens <= 0 {
			maxTokens = defaultMaxTokens
		}
		options := map[string]any{"max_tokens": maxTokens}
		if strings.Contains(strings.ToLower(system), "json") && provider != "deepseek" {
			options["response_format"] = map[string]string{"type": "json_object"}
		}
		for {
			body := map[string]any{"model": model, "messages": []map[string]string{{"role": "system", "content": system}, {"role": "user", "content": user}}, "temperature": temperature}
			for key, value := range options {
				body[key] = value
			}
			for key, value := range o.Extra {
				if value == nil {
					delete(body, key)
				} else {
					body[key] = value
				}
			}
			request, _ := json.Marshal(body)
			raw, err := c.post(ctx, c.origin(provider)+chatPaths[provider], c.Keys[provider], "application/json", 5*time.Minute, func() (io.Reader, string) { return strings.NewReader(string(request)), "" }, "a IA")
			var refused *Refused
			if errors.As(err, &refused) && (refused.Status == http.StatusBadRequest || refused.Status == http.StatusUnprocessableEntity) {
				if _, ok := options["response_format"]; ok {
					delete(options, "response_format")
					continue
				}
				if _, ok := options["max_tokens"]; ok {
					delete(options, "max_tokens")
					continue
				}
			}
			if err != nil {
				return "", Usage{}, err
			}
			text, usage, err := answerWithUsage(raw)
			if err != nil {
				return "", Usage{}, err
			}
			if usage.Input == 0 && usage.Output == 0 {
				usage.Input = int(math.Round(float64(len([]rune(user))+len([]rune(system))) / 4))
				usage.Output = int(math.Round(float64(len([]rune(text))) / 4))
				usage.Estimated = true
			}
			return text, usage, nil
		}
	}
}

func answerWithUsage(raw []byte) (string, Usage, error) {
	var answer struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Usage struct {
			Prompt     int      `json:"prompt_tokens"`
			Completion int      `json:"completion_tokens"`
			Cost       *float64 `json:"cost"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(raw, &answer); err != nil || len(answer.Choices) == 0 {
		return "", Usage{}, errors.New("a IA respondeu vazio")
	}
	usage := Usage{Input: answer.Usage.Prompt, Output: answer.Usage.Completion}
	if answer.Usage.Cost != nil {
		usage.Cost = *answer.Usage.Cost
	}
	return answer.Choices[0].Message.Content, usage, nil
}

// Refused is a provider that answered the request with an error: who, the status and what it said.
type Refused struct {
	Who    string
	Status int
	Detail string
}

func (r *Refused) Error() string {
	if r.Detail == "" {
		return fmt.Sprintf("%s recusou o pedido (%d)", r.Who, r.Status)
	}
	return fmt.Sprintf("%s recusou o pedido (%d): %s", r.Who, r.Status, r.Detail)
}
