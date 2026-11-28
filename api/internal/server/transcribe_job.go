package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/regyeduardo/study-helper/api/internal/transcribe"
)

// T206 (dono, 28/11: "a prioridade máxima é o backend go"; FR-080, FR-081, FR-084): a transcription asked in the account runs in the
// backend in Go, without the Chromium. Measured on the real 90 min meeting of 27/11 (research R27 to R33): 52 s, US$ 0.085, 25 MB in
// Go and 56 MB in the ffmpeg that cuts the audio (the Chromium took 33 min and ~1.2 GB). The note gets the transcription in the same
// format the browser writes (src/stores/jobs.ts, transcribeNote).

// serverDevice marks a job the server runs itself (no page enters it: the check of a page that never opened does not apply).
const serverDevice = "servidor"

// speechModel are the models heard by /audio/transcriptions (src/lib/ai/config.ts).
var speechModel = regexp.MustCompile(`(?i)whisper|transcri|voxtral|parakeet|canary|speech|asr|\bstt\b`)

// aiChoice is the administration's choice of models (app_settings `ai_uses`, as the app keeps it: providers, models, defaults by use).
type aiChoice struct {
	Providers []struct {
		ID   string `json:"id"`
		Type string `json:"type"`
	} `json:"providers"`
	Models []struct {
		UID string `json:"uid"`
		PID string `json:"pid"`
		MID string `json:"mid"`
	} `json:"models"`
	Defaults map[string]string `json:"defaults"`
}

func (srv *Server) aiChoice() aiChoice {
	var choice aiChoice
	_ = json.Unmarshal(srv.aiUses(), &choice)
	return choice
}

// target is the provider type and the model of a uid; "" when it is not in the choice.
func (c aiChoice) target(uid string) (string, string) {
	for _, model := range c.Models {
		if model.UID != uid {
			continue
		}
		for _, provider := range c.Providers {
			if provider.ID == model.PID {
				return provider.Type, model.MID
			}
		}
	}
	return "", ""
}

// uidFor is the model of a use, or of the use it inherits from (src/lib/ai/config.ts, uidFor).
func (c aiChoice) uidFor(use, from string) string {
	if uid := c.Defaults[use]; uid != "" {
		if provider, _ := c.target(uid); provider != "" {
			return uid
		}
	}
	if uid := c.Defaults[from]; uid != "" {
		if provider, _ := c.target(uid); provider != "" {
			return uid
		}
	}
	return ""
}

// goTranscription is a transcribeNote the backend in Go runs.
type goTranscription struct {
	userID, fileID string
	picked         string // the model chosen at the time ("" the account's default)
	times          string // the DeepInfra model of the times of each word
	instruction    string
	row            *libraryRow
	// T205: the screen the recording marked is read (strict: the person chose it), by this vision model ("" the account's)
	screen, strict bool
	vision         string
}

// goTranscriptionOf says whether a job runs in Go: a transcribeNote of a note kept in the App, by a speech model of DeepInfra, with the
// server's key. The screen is read in Go too (T205): by the marks of the recording, or by frames the ffmpeg takes of a video from outside.
func (srv *Server) goTranscriptionOf(id, userID string) *goTranscription {
	var call, request string
	if err := srv.db.QueryRow(`SELECT call, request FROM jobs WHERE id = ?`, id).Scan(&call, &request); err != nil || call != "transcribeNote" {
		return nil
	}
	var asked struct {
		Args []json.RawMessage `json:"args"`
	}
	if json.Unmarshal([]byte(request), &asked) != nil || len(asked.Args) == 0 {
		return nil
	}
	arg := func(index int, into any) {
		if index < len(asked.Args) {
			_ = json.Unmarshal(asked.Args[index], into)
		}
	}
	plan := &goTranscription{userID: userID}
	arg(0, &plan.fileID)
	arg(2, &plan.picked)
	arg(3, &plan.instruction)
	var screen struct {
		Read  *bool  `json:"read"`
		Model string `json:"model"`
	}
	arg(4, &screen)
	row, err := findRow(srv.db, userID, plan.fileID)
	if err != nil || row == nil || row.RemovedAt != nil || row.Media == nil || row.Media.Status != "stored" {
		return nil
	}
	if (strings.HasPrefix(row.Media.Mime, "video/") || row.Parts["telas/000"] != "") && (screen.Read == nil || *screen.Read) {
		plan.screen, plan.strict, plan.vision = true, screen.Read != nil, screen.Model
	}
	choice := srv.aiChoice()
	uid := plan.picked
	if uid == "" {
		uid = choice.uidFor("transcricao", "midia")
	}
	provider, model := choice.target(uid)
	if provider != "deepinfra" || !speechModel.MatchString(model) || srv.cfg.AI.Keys["deepinfra"] == "" {
		return nil
	}
	plan.times, plan.row = model, row
	return plan
}

// readPart is the content of a part of a note, or "" when there is none.
func (srv *Server) readPart(ctx context.Context, userID string, row *libraryRow, part string) string {
	version := row.Parts[part]
	if version == "" {
		return ""
	}
	reader, _, err := srv.cfg.Blobs.Get(ctx, partKey(userID, row.ID, part, version), nil)
	if err != nil {
		return ""
	}
	defer reader.Close()
	out, _ := io.ReadAll(io.LimitReader(reader, maxPartBytes))
	return string(out)
}

// writePart writes a new version of a part of a note, over whatever version it is at (the job owns the note while it runs).
func (srv *Server) writePart(ctx context.Context, userID, id, part string, body []byte) (int64, error) {
	for round := 0; round < 4; round++ {
		row, err := findRow(srv.db, userID, id)
		if err != nil || row == nil || row.RemovedAt != nil {
			return 0, errors.New("a nota não está mais lá")
		}
		base := row.Parts[part]
		version := srv.newVersion()
		key := partKey(userID, id, part, version)
		if err := srv.cfg.Blobs.Put(ctx, key, body, contentTypeOf(part), map[string]string{"user": userID, "item": id, "part": part}); err != nil {
			return 0, err
		}
		oldBytes := int64(0)
		if base != "" {
			oldBytes = srv.sizeOf(ctx, partKey(userID, id, part, base))
		}
		seq, err := srv.swapPart(userID, id, part, base, version, int64(len(body))-oldBytes)
		if errors.Is(err, errStale) {
			_ = srv.cfg.Blobs.Delete(ctx, key)
			continue
		}
		if err != nil {
			return 0, err
		}
		srv.notifyMap(userID, seq)
		srv.notifySpace(userID)
		return seq, nil
	}
	return 0, errors.New("a nota mudou ao mesmo tempo; tente de novo")
}

// jobSays records the stage of a job the server runs (as the page does with POST /v1/jobs/{id}/progress).
func (srv *Server) jobSays(id, userID, message string, fraction *float64) {
	job, err := srv.findJob(id, userID)
	if err != nil || job == nil || job.State != "running" {
		return
	}
	now := srv.now()
	etaAt, basis := srv.estimate(job, fraction, now)
	var eta, etaBasis, value any
	if etaAt != nil {
		eta, etaBasis = ts(*etaAt), basis
	}
	if fraction != nil {
		value = min(1, max(0, *fraction))
	}
	_, _ = srv.db.Exec(`UPDATE jobs SET stage = ?, fraction = ?, eta_at = ?, eta_basis = ?, last_progress = ?, last_progress_at = ?, stalled_since = NULL, updated_at = ? WHERE id = ?`,
		message, value, eta, etaBasis, message, ts(now), ts(now), id)
	srv.notifyJob(userID, id)
}

// jobEnds records the end of a job the server ran itself.
func (srv *Server) jobEnds(id, userID, set string, args ...any) {
	now := ts(srv.now())
	values := append(args, now, now, id)
	_, _ = srv.db.Exec(`UPDATE jobs SET `+set+`, finished_at = ?, updated_at = ? WHERE id = ? AND state = 'running'`, values...)
	srv.jobs.mu.Lock()
	delete(srv.jobs.paces, id)
	srv.jobs.mu.Unlock()
	srv.notifyJob(userID, id)
	srv.wakeJobs()
}

// accountSettings are the language and the terms of the transcription the person keeps (the library's index).
func (srv *Server) accountSettings(ctx context.Context, userID string) (language, terms string) {
	language = "pt"
	var version string
	if srv.db.QueryRow(`SELECT version FROM library_index WHERE user_id = ?`, userID).Scan(&version) != nil {
		return
	}
	reader, _, err := srv.cfg.Blobs.Get(ctx, indexKey(userID, version), nil)
	if err != nil {
		return
	}
	defer reader.Close()
	var index struct {
		Settings struct {
			Transcription struct {
				Language string `json:"language"`
				Terms    string `json:"terms"`
			} `json:"transcription"`
		} `json:"settings"`
	}
	if json.NewDecoder(reader).Decode(&index) == nil {
		if index.Settings.Transcription.Language != "" {
			language = index.Settings.Transcription.Language
		}
		terms = index.Settings.Transcription.Terms
	}
	return
}

var extension = regexp.MustCompile(`(?i)\.[a-z0-9]{2,5}$`)

const (
	withoutScreen = `Para seguir sem a tela, faça de novo com "Só a transcrição".`
	noReader      = "Ninguém lê a tela: escolha um modelo de visão no passo Vídeo (ou em Configurações › Inteligência artificial › Leitura de tela)."
	tryPrompt     = "Responda só: ok"
)

const (
	darkVideo = "O vídeo está todo escuro no começo, no meio e no fim: a gravação não pegou a imagem da tela, então não há o que ler."
	dark      = 24
	flat      = 4
)

// screenReady (T188, before anything is spent): where the screen comes from and who reads it. The screens the recording marked, with
// their photos, read by the vision model or by the text the OCR read while recording; a video from outside by frames of the ffmpeg,
// tried at its start, middle and end (a picture there), read by the vision model only (no OCR in the server). The vision model is tried
// with one photo (a few tokens). "" for the reason: it can be read.
func (srv *Server) screenReady(ctx context.Context, plan *goTranscription, before *transcribe.Recording, cfg transcribe.Config, spend func(float64), media string) (transcribe.Screens, transcribe.See, string) {
	var index struct {
		MadeBy  string                    `json:"madeBy"`
		Screens []transcribe.MarkedScreen `json:"screens"`
	}
	if before != nil {
		_ = json.Unmarshal(before.ScreenIndex, &index)
	}
	marked := index.MadeBy == "gravacao" && len(index.Screens) > 0 && plan.row.Parts["telas/000"] != ""
	var screens transcribe.Screens = transcribe.VideoScreens{FFmpeg: srv.ffmpegPath(), Media: media}
	if marked {
		screens = transcribe.MarkedScreens{Screens: index.Screens, Photo: func(ctx context.Context, n int) (string, error) {
			var photo struct {
				Image string `json:"image"`
			}
			if json.Unmarshal([]byte(srv.readPart(ctx, plan.userID, plan.row, fmt.Sprintf("telas/%03d", n))), &photo) != nil || photo.Image == "" {
				return "", errors.New("a foto da tela não está na nota")
			}
			return photo.Image, nil
		}}
	} else if !strings.HasPrefix(plan.row.Media.Mime, "video/") {
		return nil, nil, "A gravação não marcou nenhuma tela."
	}
	choice := srv.aiChoice()
	uid := plan.vision
	if provider, _ := choice.target(uid); provider == "" {
		uid = choice.uidFor("tela", "midia")
	}
	if uid == "" {
		for _, screen := range index.Screens {
			if marked && len(screen.Texts) > 0 {
				return screens, nil, ""
			}
		}
		return nil, nil, noReader
	}
	// the photo of the try: the middle screen marked, or the frame of the video with most to see
	sample := ""
	if marked {
		shots, err := screens.Shots(ctx, []float64{index.Screens[len(index.Screens)/2].At})
		for _, shot := range shots {
			sample = shot.Image
		}
		if sample == "" {
			return nil, nil, "A foto da tela marcada não abriu: " + fmt.Sprint(err) + "."
		}
	} else {
		times := []float64{1}
		if duration := transcribe.Duration(ctx, srv.ffmpegPath(), media); duration > 0 {
			times = []float64{math.Round(duration*1) / 10, math.Round(duration*5) / 10, math.Round(duration*9) / 10}
		}
		shots, err := screens.Shots(ctx, times)
		if err != nil {
			return nil, nil, upperFirst(err.Error()) + "."
		}
		allDark, best := len(shots) > 0, -1.0
		for _, shot := range shots {
			mean, spread := grayOf(shot.Signature)
			if mean >= dark || spread >= flat {
				allDark = false
			}
			if spread > best {
				best, sample = spread, shot.Image
			}
		}
		if allDark {
			return nil, nil, darkVideo
		}
	}
	provider, model := choice.target(uid)
	see, err := cfg.SeeWith(provider, model, 1024, 3*time.Minute, spend)
	if err != nil {
		return nil, nil, "O modelo de visão falhou no teste com um quadro do vídeo: " + err.Error() + "."
	}
	trying := cfg
	trying.Retries = 2
	try, _ := trying.SeeWith(provider, model, 16, 30*time.Second, spend)
	if _, err := try(ctx, []string{sample}, tryPrompt); err != nil {
		return nil, nil, "O modelo de visão falhou no teste com um quadro do vídeo: " + err.Error() + "."
	}
	return screens, see, ""
}

// grayOf is the mean and the spread (standard deviation) of a gray signature, 0 to 255.
func grayOf(signature []float64) (float64, float64) {
	count := float64(max(1, len(signature)))
	mean, variance := 0.0, 0.0
	for _, value := range signature {
		mean += value
	}
	mean /= count
	for _, value := range signature {
		variance += (value - mean) * (value - mean)
	}
	return mean, math.Sqrt(variance / count)
}

func upperFirst(text string) string {
	for i, r := range text {
		return strings.ToUpper(string(r)) + text[i+len(string(r)):]
	}
	return text
}

// runGoTranscription transcribes the note in Go and writes it as the browser does; a failure fails the job with the reason.
func (srv *Server) runGoTranscription(ctx context.Context, start JobStart, plan *goTranscription) error {
	_, _ = srv.db.Exec(`UPDATE jobs SET device_id = ? WHERE id = ?`, serverDevice, start.ID)
	failAs := func(message string) error {
		srv.jobEnds(start.ID, start.UserID, `state = 'failed', error = ?, error_code = 'internal'`, message)
		return errors.New(message)
	}
	fail := func(reason string) error { return failAs("A transcrição não saiu: " + reason) }
	say := func(message string, fraction *float64) { srv.jobSays(start.ID, start.UserID, message, fraction) }
	say("Abrindo a mídia", nil)
	row := plan.row
	if free, ok := freeBytes(os.TempDir()); ok && free-row.Media.Bytes < thumbsDiskReserve {
		return fail("o servidor está sem espaço em disco para abrir a mídia agora")
	}
	media, err := srv.mediaFile(ctx, row.Media.Key)
	if err != nil {
		return fail("a mídia não abriu no servidor")
	}
	defer os.Remove(media)
	workdir, err := os.MkdirTemp("", "estudo-transcricao-*")
	if err != nil {
		return fail("o servidor não conseguiu um lugar de trabalho")
	}
	defer os.RemoveAll(workdir)

	var before struct {
		Recording *transcribe.Recording `json:"recording"`
	}
	_ = json.Unmarshal([]byte(srv.readPart(ctx, plan.userID, row, "transcript")), &before)
	var volumes *transcribe.Volumes
	if raw := srv.readPart(ctx, plan.userID, row, "volume"); raw != "" {
		if read, err := transcribe.VolumesOfPart(raw); err == nil {
			volumes = &read
		}
	}
	language, terms := srv.accountSettings(ctx, plan.userID)
	var recorder string
	_ = srv.db.QueryRow(`SELECT name FROM user WHERE id = ?`, plan.userID).Scan(&recorder)

	var spentMu sync.Mutex
	spent := 0.0
	spend := func(usd float64) {
		spentMu.Lock()
		spent += usd
		spentMu.Unlock()
	}
	cfg := transcribe.Config{
		FFmpeg: srv.ffmpegPath(), Keys: srv.cfg.AI.Keys, Origins: srv.cfg.AI.Origins, Language: language, Terms: terms, Recorder: recorder, TimesModel: plan.times,
		Progress: func(stage string, done, total int) {
			if total > 1 {
				fraction := float64(done) / float64(total)
				say(fmt.Sprintf("%s · parte %d de %d", stage, min(done+1, total), total), &fraction)
				return
			}
			say(stage, nil)
		},
	}
	if srv.cfg.HTTPClient != nil && len(srv.cfg.AI.Origins) > 0 {
		cfg.HTTP = srv.cfg.HTTPClient
	}
	if srv.cfg.AI.Keys["openrouter"] == "" {
		cfg.Listener = "-"
	}
	// T188: whether the screen can be read is known before anything is spent; the screen the person chose stops everything here
	var screens transcribe.Screens
	var see transcribe.See
	skipped := ""
	if plan.screen {
		say("Conferindo se dá para ler a tela da gravação", nil)
		screens, see, skipped = srv.screenReady(ctx, plan, before.Recording, cfg, spend, media)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if skipped != "" && plan.strict {
			return failAs(skipped + " Nada foi gasto: a transcrição nem começou. " + withoutScreen)
		}
	}
	startedAt := srv.now()
	result, err := transcribe.Run(ctx, cfg, media, volumes, workdir)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return fail(err.Error())
	}
	spend(result.Cost)
	recording := transcribe.Recording{Blocks: result.Blocks, Speakers: result.Speakers, Marks: json.RawMessage(`[]`), Warning: result.Warning}
	if before.Recording != nil {
		if len(before.Recording.Marks) > 0 {
			recording.Marks = before.Recording.Marks
		}
		recording.ScreenIndex = before.Recording.ScreenIndex
	}

	choice := srv.aiChoice()
	var chat transcribe.Chat
	if provider, model := choice.target(choice.uidFor("titulo", "estudo")); provider != "" && cfg.Asks(provider) == nil {
		chat = cfg.ChatWith(provider, model, spend)
	}
	stages := result.Stages
	looked := false
	if plan.screen && skipped == "" {
		say("Olhando a tela gravada", nil)
		lookedAt := time.Now()
		seen, err := transcribe.LookAtScreen(ctx, recording, screens, chat, see, plan.strict)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return failAs(err.Error() + " A transcrição de antes ficou como estava. " + withoutScreen)
		}
		recording, looked = seen, true
		stages = append(stages, transcribe.Stage{Name: "Olhar a tela gravada", MS: time.Since(lookedAt).Milliseconds()})
	} else if skipped != "" {
		recording.Warning = strings.TrimSpace(recording.Warning + " A tela não foi lida: " + skipped)
	}

	say("Dando título, nomes e revisando a transcrição", nil)
	polishedAt := time.Now()
	title := ""
	if chat != nil {
		recording, title = transcribe.Polish(ctx, recording, chat, terms, plan.instruction)
	}
	stages = append(stages, transcribe.Stage{Name: "Acabamento: título, nomes e revisão", MS: time.Since(polishedAt).Milliseconds()})
	heard := map[string]any{"screen": looked}
	if plan.picked != "" {
		heard["model"] = plan.picked
	}
	if looked && plan.vision != "" {
		heard["vision"] = plan.vision
	}
	recording.Heard, _ = json.Marshal(heard)
	text := strings.TrimSpace(transcribe.TranscriptText(recording.Blocks, recording.Speakers))
	transcript, _ := json.Marshal(map[string]any{"recording": recording, "transcript": text})
	if _, err := srv.writePart(ctx, plan.userID, plan.fileID, "transcript", transcript); err != nil {
		return fail("a transcrição não foi guardada na nota: " + err.Error())
	}
	if _, err := srv.writePart(ctx, plan.userID, plan.fileID, "text", []byte(text)); err != nil {
		return fail("o texto não foi guardado na nota: " + err.Error())
	}
	srv.noteTranscribed(plan, title, stages, startedAt, language)
	spentMu.Lock()
	srv.logf("jobs: %s transcrição no Go: %.1f s, US$ %.4f", start.ID, srv.now().Sub(startedAt).Seconds(), spent)
	spentMu.Unlock()
	srv.jobEnds(start.ID, start.UserID, `state = 'done', fraction = 1, stage = ?, last_progress = ?, stalled_since = NULL`, "Transcrição pronta.", "Transcrição pronta.")
	return nil
}

// noteTranscribed gives the note the title of the review (when it still has the recording's own name, as the browser does) and the
// stages of the generation; a name another note of the folder has stays as it was.
func (srv *Server) noteTranscribed(plan *goTranscription, title string, stages []transcribe.Stage, startedAt time.Time, language string) {
	row, err := findRow(srv.db, plan.userID, plan.fileID)
	if err != nil || row == nil {
		return
	}
	var meta map[string]any
	if json.Unmarshal(row.Meta, &meta) != nil || meta == nil {
		meta = map[string]any{}
	}
	generation := map[string]any{"stages": stages, "provider": "deepinfra", "model": plan.times, "startedAt": ts(startedAt), "durationMs": srv.now().Sub(startedAt).Milliseconds(), "inputTokens": 0, "outputTokens": 0, "estimatedTokens": true, "transcriptionEngine": "deepinfra", "language": language}
	meta["generation"] = generation
	name := row.Name
	origin, _ := meta["origin"].(map[string]any)
	original, _ := origin["name"].(string)
	if title != "" && title != row.Name && original != "" && row.Name == extension.ReplaceAllString(original, "") {
		name = title
		meta["name"] = title
	}
	write := func(name string) error {
		raw, _ := json.Marshal(meta)
		fields := rowFields{ItemKind: row.ItemKind, NoteType: row.NoteType, Name: name, FolderID: row.FolderID, ParentFileID: row.ParentFileID, Place: "app", Recording: row.Recording, Position: row.Position, Meta: raw, DriveRef: row.DriveRef, CreatedAt: row.CreatedAt, UpdatedAt: ts(srv.now()), TrashedAt: row.TrashedAt, TrashedWith: row.TrashedWith}
		tx, err := srv.db.Begin()
		if err != nil {
			return err
		}
		defer tx.Rollback()
		seq, err := nextSeq(tx, plan.userID)
		if err != nil {
			return err
		}
		if _, err := srv.applyRow(tx, plan.userID, plan.fileID, row.Rev, fields, seq, true); err != nil {
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
		srv.notifyMap(plan.userID, seq)
		return nil
	}
	if err := write(name); err != nil && name != row.Name {
		meta["name"] = row.Name
		_ = write(row.Name)
	}
}

var _ = sql.ErrNoRows
