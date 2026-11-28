package transcribe

import (
	"context"
	"encoding/json"
	"io"
	"math"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// T204 (research R27 to R29, R32): the transcription in the server. The audio is cut by copy (no decoding), the parts go at once, the
// times of each word come from Whisper turbo and the text from a model that hears (OpenRouter), a late part is asked again, a listener
// that does not answer leaves Whisper's words, the voices are split over the copied audio, and what it cost is added up.

// recording makes 7 s of stereo Opus (WebM), as the app records; false without ffmpeg.
func recording(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("sem ffmpeg nesta máquina")
	}
	path := filepath.Join(t.TempDir(), "reuniao.webm")
	if out, err := exec.Command("ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=7", "-ac", "2", "-c:a", "libopus", "-b:a", "32k", "-y", path).CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg: %v %s", err, out)
	}
	return path
}

func TestCutCopiesTheAudioInPartsWithoutDecoding(t *testing.T) {
	media := recording(t)
	cut, err := Cut(context.Background(), "ffmpeg", media, t.TempDir(), 3)
	if err != nil {
		t.Fatal(err)
	}
	if len(cut.Parts) != 3 || cut.Format != "ogg" {
		t.Fatalf("%+v", cut)
	}
	for k, part := range cut.Parts {
		if math.Abs(part.Start-float64(3*k)) > 0.1 {
			t.Fatalf("part %d starts at %v", k, part.Start)
		}
		if info, err := os.Stat(part.Path); err != nil || info.Size() == 0 {
			t.Fatalf("part %d: %v", k, err)
		}
	}
	if info, err := os.Stat(cut.Whole); err != nil || info.Size() == 0 || math.Abs(cut.Duration-7) > 0.2 {
		t.Fatalf("whole: %v %v", err, cut.Duration)
	}
}

// fake is DeepInfra and OpenRouter: Whisper answers "parte k." for part k; the listener answers "Parte certa."; the voice split gives
// speaker_0 up to 3.5 s and speaker_1 after.
type fake struct {
	mu          sync.Mutex
	whisper     map[string]int
	prompts     []string
	listened    []map[string]any
	stuckPart   string // the first request of this part never answers
	stuckListen bool
	failSplit   bool
}

func (f *fake) server(t *testing.T) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/v1/openai/audio/transcriptions"):
			reader, err := r.MultipartReader()
			if err != nil {
				t.Errorf("multipart: %v", err)
				return
			}
			fields, name := map[string]string{}, ""
			for {
				part, err := reader.NextPart()
				if err == io.EOF {
					break
				}
				if part.FileName() != "" {
					name = part.FileName()
					_, _ = io.Copy(io.Discard, part)
					continue
				}
				value, _ := io.ReadAll(part)
				fields[part.FormName()] = string(value)
			}
			f.mu.Lock()
			f.whisper[name]++
			first := f.whisper[name] == 1
			if prompt, ok := fields["prompt"]; ok {
				f.prompts = append(f.prompts, prompt)
			}
			f.mu.Unlock()
			if name == f.stuckPart && first {
				<-r.Context().Done()
				return
			}
			k := strings.TrimSuffix(strings.TrimPrefix(name, "p00"), ".ogg")
			_ = json.NewEncoder(w).Encode(map[string]any{"text": " parte " + k + ".", "duration": 3, "words": []map[string]any{{"word": " parte", "start": 0.5, "end": 1}, {"word": " " + k + ".", "start": 1, "end": 1.5}}})
		case strings.HasSuffix(r.URL.Path, "/api/v1/chat/completions"):
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			f.mu.Lock()
			f.listened = append(f.listened, body)
			f.mu.Unlock()
			if f.stuckListen {
				<-r.Context().Done()
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"choices": []map[string]any{{"message": map[string]any{"content": "Parte certa."}}}, "usage": map[string]any{"cost": 0.0004}})
		case strings.HasSuffix(r.URL.Path, "/v1/inference/nvidia/Nemotron-3-Diarization"):
			_, _ = io.Copy(io.Discard, r.Body)
			if f.failSplit {
				http.Error(w, `{"detail":"inference error"}`, http.StatusInternalServerError)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"speaker_segments": []map[string]any{{"start": 0, "end": 3.5, "speaker": "speaker_0"}, {"start": 3.5, "end": 7.5, "speaker": "speaker_1"}}, "inference_status": map[string]any{"cost": 0.002}})
		default:
			http.NotFound(w, r)
		}
	}))
}

func config(origin string) Config {
	return Config{
		FFmpeg:      "ffmpeg",
		Keys:        map[string]string{"deepinfra": "di", "openrouter": "or"},
		Origins:     map[string]string{"deepinfra": origin, "openrouter": origin},
		Language:    "pt",
		PartSeconds: 3,
		Retries:     1,
	}
}

func TestTheTranscriptionIsPutTogetherFromTheTimesOfWhisperAndTheTextOfTheListener(t *testing.T) {
	media := recording(t)
	f := &fake{whisper: map[string]int{}}
	server := f.server(t)
	defer server.Close()
	cfg := config(server.URL)
	cfg.Terms = "BGV, Kubernetes"
	result, err := Run(context.Background(), cfg, media, nil, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Blocks) != 3 || result.Blocks[0].Speaker != "speaker_0" || result.Blocks[1].Speaker != "speaker_1" {
		t.Fatalf("blocks %+v", result.Blocks)
	}
	for _, b := range result.Blocks {
		if b.Text != "Parte certa." {
			t.Fatalf("the text of the listener on the times of Whisper: %+v", result.Blocks)
		}
	}
	// the parts start where ffmpeg cut them, on an Opus packet (3.001 s, not 3 s)
	if math.Abs(result.Blocks[1].Start-3.5) > 0.05 || result.Speakers[0].Name != "Falante 1" || !strings.HasPrefix(result.Text, "Falante 1 [00:00]: Parte certa.\n") {
		t.Fatalf("%+v %q", result.Blocks, result.Text)
	}
	// never the terms to Whisper (R28: the turbo skipped nearly everything); to the listener, as context
	if len(f.prompts) != 0 {
		t.Fatalf("a prompt went to Whisper: %v", f.prompts)
	}
	sent, _ := json.Marshal(f.listened[0])
	if !strings.Contains(string(sent), `"reasoning":{"enabled":false}`) || !strings.Contains(string(sent), `"format":"ogg"`) || !strings.Contains(string(sent), "BGV, Kubernetes") || !strings.Contains(string(sent), "qwen/qwen3.8-omni-flash") {
		t.Fatalf("listener request: %s", sent)
	}
	// turbo at US$ 0.012 an hour for 9 s, the listener's 3 x 0.0004 and the split's 0.002
	if want := 0.012*9/3600 + 3*0.0004 + 0.002; math.Abs(result.Cost-want) > 1e-9 {
		t.Fatalf("cost %v want %v", result.Cost, want)
	}
}

func TestALatePartIsAskedAgainAndTheFirstAnswerWins(t *testing.T) {
	media := recording(t)
	f := &fake{whisper: map[string]int{}, stuckPart: "p001.ogg"}
	server := f.server(t)
	defer server.Close()
	cfg := config(server.URL)
	cfg.LateMin = 300 * time.Millisecond
	started := time.Now()
	result, err := Run(context.Background(), cfg, media, nil, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if took := time.Since(started); took > 5*time.Second {
		t.Fatalf("held by the late part: %v", took)
	}
	if f.whisper["p001.ogg"] != 2 || len(result.Blocks) != 3 {
		t.Fatalf("asked %d times, blocks %+v", f.whisper["p001.ogg"], result.Blocks)
	}
}

func TestAListenerThatDoesNotAnswerLeavesTheWordsOfWhisper(t *testing.T) {
	media := recording(t)
	f := &fake{whisper: map[string]int{}, stuckListen: true}
	server := f.server(t)
	defer server.Close()
	cfg := config(server.URL)
	cfg.TextGraceMin = 200 * time.Millisecond
	cfg.TextGracePerSecond = 0.01
	result, err := Run(context.Background(), cfg, media, nil, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(result.Text, "parte 0.") || !strings.Contains(result.Text, "parte 2.") {
		t.Fatalf("%q", result.Text)
	}
}

func TestVoicesNotSplitSayWhy(t *testing.T) {
	media := recording(t)
	f := &fake{whisper: map[string]int{}, failSplit: true}
	server := f.server(t)
	defer server.Close()
	result, err := Run(context.Background(), config(server.URL), media, nil, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(result.Warning, "Os falantes não foram separados:") || result.Blocks[0].Speaker != "" {
		t.Fatalf("%q %+v", result.Warning, result.Blocks)
	}
}

// the multipart reader must not be unused when the package grows
var _ = multipart.ErrMessageTooLarge
