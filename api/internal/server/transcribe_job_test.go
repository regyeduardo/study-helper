package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// T206 (dono, 28/11: "a prioridade máxima é o backend go"; FR-080, FR-081, FR-084): a transcription asked in the account runs in the
// backend in Go, without the Chromium: the note gets the transcription in the same format the browser writes, and the job ends with it.

// fakeProviders is DeepInfra and OpenRouter for the job: Whisper "parte k.", the listener "Parte certa.", one voice, a title.
func fakeProviders(t *testing.T) (*httptest.Server, *sync.Map) {
	seen := &sync.Map{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/v1/openai/audio/transcriptions"):
			_, _ = io.Copy(io.Discard, r.Body)
			seen.Store("whisper", true)
			_ = json.NewEncoder(w).Encode(map[string]any{"text": " parte.", "duration": 3, "words": []map[string]any{{"word": " parte", "start": 0.5, "end": 1}, {"word": " um.", "start": 1, "end": 1.5}}})
		case strings.HasSuffix(r.URL.Path, "/api/v1/chat/completions"):
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			raw, _ := json.Marshal(body)
			if strings.Contains(string(raw), "image_url") {
				seen.Store("vision", true)
				if _, refuse := seen.Load("refuse-vision"); refuse {
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				answer := `{"texto": "", "nome": "Natália"}`
				if strings.Contains(string(raw), "Responda só: ok") {
					seen.Store("vision-tried", true)
					answer = "ok"
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"choices": []map[string]any{{"message": map[string]any{"content": answer}}}, "usage": map[string]any{"cost": 0.0002}})
				return
			}
			if strings.Contains(string(raw), "input_audio") {
				seen.Store("listener", true)
				_ = json.NewEncoder(w).Encode(map[string]any{"choices": []map[string]any{{"message": map[string]any{"content": "Parte certa."}}}, "usage": map[string]any{"cost": 0.0004}})
				return
			}
			seen.Store("polish", true)
			_ = json.NewEncoder(w).Encode(map[string]any{"choices": []map[string]any{{"message": map[string]any{"content": `{"titulo": "Reunião do orçamento", "nomes": [], "correcoes": []}`}}}})
		case strings.HasSuffix(r.URL.Path, "/v1/inference/nvidia/Nemotron-3-Diarization"):
			_, _ = io.Copy(io.Discard, r.Body)
			_ = json.NewEncoder(w).Encode(map[string]any{"speaker_segments": []map[string]any{{"start": 0, "end": 8, "speaker": "speaker_0"}}, "inference_status": map[string]any{"cost": 0.002}})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	return server, seen
}

// audioOf is 7 s of Opus in WebM, as the app records the sound of a meeting.
func audioOf(t *testing.T) []byte {
	t.Helper()
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("sem ffmpeg nesta máquina")
	}
	out, err := exec.Command("ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=7", "-ac", "2", "-c:a", "libopus", "-b:a", "32k", "-f", "webm", "pipe:1").Output()
	if err != nil {
		t.Fatalf("ffmpeg: %v", err)
	}
	return out
}

func TestATranscriptionInTheAccountRunsInGoWithoutTheChromium(t *testing.T) {
	h := newHarness(t)
	providers, seen := fakeProviders(t)
	h.srv.cfg.AI = AIConfig{Keys: map[string]string{"deepinfra": "di", "openrouter": "or"}, Origins: map[string]string{"deepinfra": providers.URL, "openrouter": providers.URL}}
	chromium := false
	h.srv.cfg.JobRunner = func(ctx context.Context, start JobStart) error { chromium = true; <-ctx.Done(); return nil }
	ana, anaID := h.account("enabled", true, "ana@exemplo.com")
	// the account's audio note, kept in the App (as recorded: the default name of the recording)
	audio := audioOf(t)
	if err := h.blobs.Put(context.Background(), "u/"+anaID+"/m/n1/m1", audio, "audio/webm", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := h.db.Exec(`INSERT INTO library_items (user_id, id, item_kind, note_type, name, place, position, meta, media, media_bytes, created_at, updated_at, rev, seq) VALUES (?, 'n1', 'file', 'audio', 'Reunião 28-11-2026', 'app', 0, ?, ?, ?, '2026-11-28T10:00:00Z', '2026-11-28T10:00:00Z', 1, 1)`,
		anaID, `{"id":"n1","name":"Reunião 28-11-2026","origin":{"input":"recording","name":"Reunião 28-11-2026.webm"}}`, `{"id":"m1","key":"u/`+anaID+`/m/n1/m1","mime":"audio/webm","bytes":`+strconv.Itoa(len(audio))+`,"status":"stored"}`, len(audio)); err != nil {
		t.Fatal(err)
	}
	// the administration's choice: Whisper turbo of DeepInfra for the transcription, a text model of OpenRouter for the title
	uses := `{"providers":[{"id":"di","type":"deepinfra"},{"id":"or","type":"openrouter"}],"models":[{"uid":"di::openai/whisper-large-v3-turbo","pid":"di","mid":"openai/whisper-large-v3-turbo"},{"uid":"or::texto","pid":"or","mid":"texto"}],"defaults":{"transcricao":"di::openai/whisper-large-v3-turbo","estudo":"or::texto"}}`
	if _, err := h.db.Exec(`INSERT OR REPLACE INTO app_settings (key, value) VALUES ('ai_uses', ?)`, uses); err != nil {
		t.Fatal(err)
	}
	res, body := h.do(ana, call{method: http.MethodPost, path: "/v1/jobs", body: map[string]any{"call": "transcribeNote", "args": []any{"n1", nil, nil, "", map[string]any{"read": false}}, "fileId": "n1", "title": "Transcrição · Reunião"}})
	if res.StatusCode != http.StatusAccepted {
		t.Fatalf("job: %d %v", res.StatusCode, body)
	}
	id, _ := body["id"].(string)
	deadline := time.Now().Add(20 * time.Second)
	var job map[string]any
	for time.Now().Before(deadline) {
		_, job = h.do(ana, call{path: "/v1/jobs/" + id})
		if job["state"] == "done" || job["state"] == "failed" {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if job["state"] != "done" || chromium {
		t.Fatalf("job %v, chromium %v", job, chromium)
	}
	for _, step := range []string{"whisper", "listener", "polish"} {
		if _, ok := seen.Load(step); !ok {
			t.Fatalf("%s was not asked", step)
		}
	}
	// the note: the transcription in the part `transcript`, the text, and the title the review gave
	row, err := findRow(h.db, anaID, "n1")
	if err != nil || row == nil {
		t.Fatal(err)
	}
	part := func(name string) string {
		reader, _, err := h.blobs.Get(context.Background(), partKey(anaID, "n1", name, row.Parts[name]), nil)
		if err != nil {
			t.Fatalf("%s: %v (%v)", name, err, row.Parts)
		}
		defer reader.Close()
		out, _ := io.ReadAll(reader)
		return string(out)
	}
	var transcript struct {
		Recording struct {
			Blocks   []map[string]any `json:"blocks"`
			Speakers []map[string]any `json:"speakers"`
			Heard    map[string]any   `json:"heard"`
		} `json:"recording"`
		Transcript string `json:"transcript"`
	}
	if err := json.Unmarshal([]byte(part("transcript")), &transcript); err != nil {
		t.Fatal(err)
	}
	if len(transcript.Recording.Blocks) == 0 || transcript.Recording.Blocks[0]["text"] != "Parte certa." || transcript.Recording.Heard["screen"] != false || !strings.HasPrefix(transcript.Transcript, "Falante 1 [00:00]: Parte certa.") {
		t.Fatalf("transcript %+v", transcript)
	}
	if text := part("text"); text != transcript.Transcript {
		t.Fatalf("text %q", text)
	}
	if row.Name != "Reunião do orçamento" {
		t.Fatalf("name %q", row.Name)
	}
}

// screenNote is a recording whose screen the recording marked (T201): the video kept in the App, the index of its screens in the note,
// and the photo of each screen in the part `telas/<n>`.
func screenNote(t *testing.T, h *harness, userID string) {
	t.Helper()
	audio := audioOf(t)
	if err := h.blobs.Put(context.Background(), "u/"+userID+"/m/n2/m2", audio, "video/webm", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := h.db.Exec(`INSERT INTO library_items (user_id, id, item_kind, note_type, name, place, position, meta, media, media_bytes, created_at, updated_at, rev, seq) VALUES (?, 'n2', 'file', 'video', 'Reunião 28-11-2026', 'app', 0, ?, ?, ?, '2026-11-28T10:00:00Z', '2026-11-28T10:00:00Z', 1, 1)`,
		userID, `{"id":"n2","name":"Reunião 28-11-2026","origin":{"input":"recording","name":"Reunião 28-11-2026.webm"}}`, `{"id":"m2","key":"u/`+userID+`/m/n2/m2","mime":"video/webm","bytes":`+strconv.Itoa(len(audio))+`,"status":"stored"}`, len(audio)); err != nil {
		t.Fatal(err)
	}
	marked := `{"recording":{"blocks":[],"speakers":[],"marks":[],"screenIndex":{"width":1280,"height":720,"area":{"x":0,"y":0,"w":1280,"h":720},"madeBy":"gravacao","screens":[{"at":0,"end":7,"texts":[{"text":"Projeto Atlas","confidence":0.96}]}]}},"transcript":""}`
	for part, body := range map[string]string{"transcript": marked, "telas/000": `{"image":"data:image/jpeg;base64,TELA0"}`} {
		if _, err := h.srv.writePart(context.Background(), userID, "n2", part, []byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	uses := `{"providers":[{"id":"di","type":"deepinfra"},{"id":"or","type":"openrouter"}],"models":[{"uid":"di::openai/whisper-large-v3-turbo","pid":"di","mid":"openai/whisper-large-v3-turbo"},{"uid":"or::texto","pid":"or","mid":"texto"},{"uid":"or::visao","pid":"or","mid":"visao"}],"defaults":{"transcricao":"di::openai/whisper-large-v3-turbo","estudo":"or::texto","tela":"or::visao"}}`
	if _, err := h.db.Exec(`INSERT OR REPLACE INTO app_settings (key, value) VALUES ('ai_uses', ?)`, uses); err != nil {
		t.Fatal(err)
	}
}

func waitJob(t *testing.T, h *harness, who *http.Client, id string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	var job map[string]any
	for time.Now().Before(deadline) {
		_, job = h.do(who, call{path: "/v1/jobs/" + id})
		if job["state"] == "done" || job["state"] == "failed" {
			return job
		}
		time.Sleep(50 * time.Millisecond)
	}
	return job
}

// T205 ("se marcar pra ver a tela é pra ver a tela"; dono, 28/11: "a prioridade máxima é o backend go"): the screen the recording
// marked is read in Go, from its photos: the vision model is tried before anything is spent, then looks; nothing goes to the Chromium.
func TestTheScreenTheRecordingMarkedIsReadInGo(t *testing.T) {
	h := newHarness(t)
	providers, seen := fakeProviders(t)
	h.srv.cfg.AI = AIConfig{Keys: map[string]string{"deepinfra": "di", "openrouter": "or"}, Origins: map[string]string{"deepinfra": providers.URL, "openrouter": providers.URL}}
	chromium := false
	h.srv.cfg.JobRunner = func(ctx context.Context, start JobStart) error { chromium = true; <-ctx.Done(); return nil }
	ana, anaID := h.account("enabled", true, "ana@exemplo.com")
	screenNote(t, h, anaID)
	res, body := h.do(ana, call{method: http.MethodPost, path: "/v1/jobs", body: map[string]any{"call": "transcribeNote", "args": []any{"n2", nil, nil, "", map[string]any{"read": true}}, "fileId": "n2", "title": "Transcrição · Reunião"}})
	if res.StatusCode != http.StatusAccepted {
		t.Fatalf("job: %d %v", res.StatusCode, body)
	}
	job := waitJob(t, h, ana, body["id"].(string))
	if job["state"] != "done" || chromium {
		t.Fatalf("job %v, chromium %v", job, chromium)
	}
	for _, step := range []string{"vision-tried", "vision", "whisper"} {
		if _, ok := seen.Load(step); !ok {
			t.Fatalf("%s was not asked", step)
		}
	}
	row, _ := findRow(h.db, anaID, "n2")
	var transcript struct {
		Recording struct {
			Heard       map[string]any   `json:"heard"`
			ScreenTerms []string         `json:"screenTerms"`
			ScreenIndex map[string]any   `json:"screenIndex"`
			Blocks      []map[string]any `json:"blocks"`
		} `json:"recording"`
	}
	if err := json.Unmarshal([]byte(h.srv.readPart(context.Background(), anaID, row, "transcript")), &transcript); err != nil {
		t.Fatal(err)
	}
	if transcript.Recording.Heard["screen"] != true || len(transcript.Recording.ScreenTerms) == 0 || transcript.Recording.ScreenTerms[0] != "Projeto Atlas" || transcript.Recording.ScreenIndex["madeBy"] != "gravacao" || len(transcript.Recording.Blocks) == 0 {
		t.Fatalf("transcript %+v", transcript.Recording)
	}
}

// T188: the vision model that refuses the try fails the screen the person chose before anything is spent (the transcription never starts).
func TestTheChosenScreenThatCannotBeReadFailsBeforeAnythingIsSpent(t *testing.T) {
	h := newHarness(t)
	providers, seen := fakeProviders(t)
	seen.Store("refuse-vision", true)
	h.srv.cfg.AI = AIConfig{Keys: map[string]string{"deepinfra": "di", "openrouter": "or"}, Origins: map[string]string{"deepinfra": providers.URL, "openrouter": providers.URL}}
	h.srv.cfg.JobRunner = func(ctx context.Context, start JobStart) error { <-ctx.Done(); return nil }
	ana, anaID := h.account("enabled", true, "ana@exemplo.com")
	screenNote(t, h, anaID)
	_, body := h.do(ana, call{method: http.MethodPost, path: "/v1/jobs", body: map[string]any{"call": "transcribeNote", "args": []any{"n2", nil, nil, "", map[string]any{"read": true}}, "fileId": "n2", "title": "Transcrição · Reunião"}})
	job := waitJob(t, h, ana, body["id"].(string))
	message, _ := job["error"].(string)
	if job["state"] != "failed" || !strings.Contains(message, "O modelo de visão falhou no teste") || !strings.Contains(message, "Nada foi gasto") {
		t.Fatalf("job %v", job)
	}
	if _, ok := seen.Load("whisper"); ok {
		t.Fatal("the transcription started")
	}
}

// videoNote is a video brought from outside, without marks: `color` for 7 s at 1280×720 with the sound of a meeting.
func videoNote(t *testing.T, h *harness, userID, color string) {
	t.Helper()
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("sem ffmpeg nesta máquina")
	}
	video, err := exec.Command("ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "color=c="+color+":s=1280x720:d=7:r=5", "-f", "lavfi", "-i", "sine=frequency=440:duration=7",
		"-ac", "2", "-c:v", "libvpx", "-b:v", "100k", "-c:a", "libopus", "-b:a", "32k", "-shortest", "-f", "webm", "pipe:1").Output()
	if err != nil {
		t.Fatalf("ffmpeg: %v", err)
	}
	if err := h.blobs.Put(context.Background(), "u/"+userID+"/m/n3/m3", video, "video/webm", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := h.db.Exec(`INSERT INTO library_items (user_id, id, item_kind, note_type, name, place, position, meta, media, media_bytes, created_at, updated_at, rev, seq) VALUES (?, 'n3', 'file', 'video', 'Aula importada', 'app', 0, ?, ?, ?, '2026-11-28T10:00:00Z', '2026-11-28T10:00:00Z', 1, 1)`,
		userID, `{"id":"n3","name":"Aula importada","origin":{"input":"file","name":"Aula importada.webm"}}`, `{"id":"m3","key":"u/`+userID+`/m/n3/m3","mime":"video/webm","bytes":`+strconv.Itoa(len(video))+`,"status":"stored"}`, len(video)); err != nil {
		t.Fatal(err)
	}
	uses := `{"providers":[{"id":"di","type":"deepinfra"},{"id":"or","type":"openrouter"}],"models":[{"uid":"di::openai/whisper-large-v3-turbo","pid":"di","mid":"openai/whisper-large-v3-turbo"},{"uid":"or::texto","pid":"or","mid":"texto"},{"uid":"or::visao","pid":"or","mid":"visao"}],"defaults":{"transcricao":"di::openai/whisper-large-v3-turbo","estudo":"or::texto","tela":"or::visao"}}`
	if _, err := h.db.Exec(`INSERT OR REPLACE INTO app_settings (key, value) VALUES ('ai_uses', ?)`, uses); err != nil {
		t.Fatal(err)
	}
}

// T205: a video from outside, without marks, has its screen read in Go too, by frames the ffmpeg of the server takes.
func TestTheScreenOfAVideoFromOutsideIsReadInGoByTheFramesOfTheFFmpeg(t *testing.T) {
	h := newHarness(t)
	providers, seen := fakeProviders(t)
	h.srv.cfg.AI = AIConfig{Keys: map[string]string{"deepinfra": "di", "openrouter": "or"}, Origins: map[string]string{"deepinfra": providers.URL, "openrouter": providers.URL}}
	chromium := false
	h.srv.cfg.JobRunner = func(ctx context.Context, start JobStart) error { chromium = true; <-ctx.Done(); return nil }
	ana, anaID := h.account("enabled", true, "ana@exemplo.com")
	videoNote(t, h, anaID, "white")
	_, body := h.do(ana, call{method: http.MethodPost, path: "/v1/jobs", body: map[string]any{"call": "transcribeNote", "args": []any{"n3", nil, nil, "", map[string]any{"read": true}}, "fileId": "n3", "title": "Transcrição · Aula"}})
	job := waitJob(t, h, ana, body["id"].(string))
	if job["state"] != "done" || chromium {
		t.Fatalf("job %v, chromium %v", job, chromium)
	}
	if _, ok := seen.Load("vision-tried"); !ok {
		t.Fatal("the vision model was not tried")
	}
	row, _ := findRow(h.db, anaID, "n3")
	var transcript struct {
		Recording struct {
			Heard map[string]any `json:"heard"`
		} `json:"recording"`
	}
	_ = json.Unmarshal([]byte(h.srv.readPart(context.Background(), anaID, row, "transcript")), &transcript)
	if transcript.Recording.Heard["screen"] != true {
		t.Fatalf("heard %v", transcript.Recording.Heard)
	}
}

// T188: a video all dark at its start, middle and end has no screen to read: the screen chosen fails before anything is spent.
func TestADarkVideoFailsTheChosenScreenBeforeAnythingIsSpent(t *testing.T) {
	h := newHarness(t)
	providers, seen := fakeProviders(t)
	h.srv.cfg.AI = AIConfig{Keys: map[string]string{"deepinfra": "di", "openrouter": "or"}, Origins: map[string]string{"deepinfra": providers.URL, "openrouter": providers.URL}}
	h.srv.cfg.JobRunner = func(ctx context.Context, start JobStart) error { <-ctx.Done(); return nil }
	ana, anaID := h.account("enabled", true, "ana@exemplo.com")
	videoNote(t, h, anaID, "black")
	_, body := h.do(ana, call{method: http.MethodPost, path: "/v1/jobs", body: map[string]any{"call": "transcribeNote", "args": []any{"n3", nil, nil, "", map[string]any{"read": true}}, "fileId": "n3", "title": "Transcrição · Aula"}})
	job := waitJob(t, h, ana, body["id"].(string))
	message, _ := job["error"].(string)
	if job["state"] != "failed" || !strings.Contains(message, "todo escuro") || !strings.Contains(message, "Nada foi gasto") {
		t.Fatalf("job %v", job)
	}
	for _, step := range []string{"whisper", "vision"} {
		if _, ok := seen.Load(step); ok {
			t.Fatalf("%s was asked", step)
		}
	}
}
