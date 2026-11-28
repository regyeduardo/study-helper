package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/regyeduardo/study-helper/api/internal/generate"
	"github.com/regyeduardo/study-helper/api/internal/prompts"
	"github.com/regyeduardo/study-helper/api/internal/transcribe"
)

// T207: the writing of a note in Go (src/stores/jobs.ts, runOnFile and writeDocument): the Aula and the Explicação by the lesson writer,
// the Ata in two passes; kept as the app keeps it (the text, the words and the reading time, the generation, "Pronta"), with the
// activity in the index and the tags suggested after.

var (
	agentUse     = map[string]string{"lesson": "aula", "explanation": "explicacao", "meeting": "ata", "reading": "estudo"}
	agentPrompt  = map[string]string{"lesson": "LESSON_PROMPT", "explanation": "EXPLANATION_PROMPT", "meeting": "MEETING_PROMPT"}
	agentLabel   = map[string]string{"lesson": "Aula", "explanation": "Explicação", "meeting": "Ata", "reading": "Leitura"}
	numberedName = regexp.MustCompile(`^(.*\S) \((\d+)\)$`)
)

const wordsPerMinute = 200

// genSession is the AI of one generation and what it took (GenerationSession: the model, the tokens, the time).
type genSession struct {
	provider, model string
	started         time.Time
	mu              sync.Mutex
	input, output   int
	calls           int
	estimated       bool
	cost            float64
	ask             func(ctx context.Context, user, system string, o transcribe.AskOptions) (string, transcribe.Usage, error)
}

func (s *genSession) chat(ctx context.Context, user, system string, maxTokens int) (string, error) {
	text, usage, err := s.ask(ctx, user, system, transcribe.AskOptions{MaxTokens: maxTokens})
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	s.calls++
	s.input += usage.Input
	s.output += usage.Output
	s.estimated = s.estimated || usage.Estimated
	s.cost += usage.Cost
	s.mu.Unlock()
	return text, nil
}

// meta is the generation as the note keeps it (generationMeta).
func (s *genSession) meta(now time.Time, stages []transcribe.Stage) map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := map[string]any{"provider": s.provider, "model": s.model, "startedAt": isoNow(s.started), "durationMs": now.Sub(s.started).Milliseconds(), "inputTokens": s.input, "outputTokens": s.output, "estimatedTokens": s.estimated}
	if len(stages) > 0 {
		out["stages"] = stages
	}
	return out
}

// session is the AI of a use: the model picked at the time, else the default of the use; nil when the server has none.
func (srv *Server) session(pick, use string) *genSession {
	choice := srv.aiChoice()
	uid := pick
	if provider, _ := choice.target(uid); provider == "" {
		uid = choice.uidFor(use, "estudo")
	}
	provider, model := choice.target(uid)
	cfg := srv.goAI()
	if provider == "" || cfg.Asks(provider) != nil {
		return nil
	}
	return &genSession{provider: provider, model: model, started: srv.now(), ask: cfg.Measured(provider, model)}
}

// choiceOf is what a note keeps of its generation: the model picked, else the default of that moment; the instruction; when.
func (srv *Server) choiceOf(use, pick, instruction string) map[string]any {
	made := map[string]any{"at": isoNow(srv.now())}
	choice := srv.aiChoice()
	if uid := pick; uid != "" {
		made["model"] = uid
	} else if uid := choice.uidFor(use, "estudo"); uid != "" {
		made["model"] = uid
	}
	if said := strings.TrimSpace(instruction); said != "" {
		made["instruction"] = said
	}
	return made
}

func wordCount(text string) int { return len(strings.Fields(text)) }

func readingMinutes(text string) int {
	words := wordCount(text)
	if words == 0 {
		return 0
	}
	return max(1, (words+wordsPerMinute-1)/wordsPerMinute)
}

func (srv *Server) stamp() map[string]any {
	return map[string]any{"at": isoNow(srv.now()), "deviceId": serverDevice, "deviceName": "Servidor"}
}

// sourceOf is the part `source` of a note: the excerpt it came from, the material still to write, the text of its source.
type sourceOf struct {
	SourceExcerpt  *string `json:"sourceExcerpt"`
	PendingExcerpt *string `json:"pendingExcerpt"`
	SourceText     *string `json:"sourceText"`
}

func (srv *Server) sourcePart(ctx context.Context, userID string, row *libraryRow) sourceOf {
	var kept sourceOf
	_ = json.Unmarshal([]byte(srv.readPart(ctx, userID, row, "source")), &kept)
	return kept
}

// renamed tries a name; one another note of the folder has becomes "Nome (2)", as the app's freeName does.
func nextName(name string) string {
	clean := strings.TrimSpace(name)
	if found := numberedName.FindStringSubmatch(clean); found != nil {
		number, _ := strconv.Atoi(found[2])
		return fmt.Sprintf("%s (%d)", found[1], number+1)
	}
	return clean + " (2)"
}

// changeNoteNamed is changeNote that, when the name it gives is taken in the folder, takes the next free one.
func (srv *Server) changeNoteNamed(userID, fileID string, change func(row *libraryRow, meta map[string]any) (string, bool)) error {
	tried := ""
	for round := 0; round < 50; round++ {
		err := srv.changeNote(userID, fileID, func(row *libraryRow, meta map[string]any) (string, bool) {
			name, ok := change(row, meta)
			if tried != "" {
				name = tried
			}
			if name != row.Name {
				meta["name"] = name
			}
			tried = name
			return name, ok
		})
		var taken *rowError
		if errors.As(err, &taken) && taken.code == "name_taken" {
			tried = nextName(tried)
			continue
		}
		return err
	}
	return errors.New("nenhum nome livre na pasta")
}

func destinationOf(folders map[string]*libraryRow, folderID *string) string {
	if folderID != nil {
		if folder, ok := folders[*folderID]; ok {
			return `pasta "` + folder.Name + `"`
		}
	}
	return "Biblioteca (raiz)"
}

// library is the account's folders and notes, by id, for the course and the destination of a note.
type library struct {
	folders map[string]*libraryRow
	files   []*libraryRow
}

func (srv *Server) libraryOf(userID string) library {
	out := library{folders: map[string]*libraryRow{}}
	rows, err := srv.read.Query(`SELECT `+rowColumns+` FROM library_items WHERE user_id = ? AND removed_at IS NULL`, userID)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		row, err := scanRow(rows)
		if err != nil {
			continue
		}
		if row.ItemKind == "folder" {
			out.folders[row.ID] = row
		} else {
			out.files = append(out.files, row)
		}
	}
	return out
}

func live(row *libraryRow) bool { return row.TrashedAt == nil && row.RemovedAt == nil }

func (lib library) isCourse(folderID string) bool {
	for _, folder := range lib.folders {
		if folder.FolderID != nil && *folder.FolderID == folderID && live(folder) {
			return true
		}
	}
	return false
}

// courseOf is the course a note is in (a folder with folders inside, going up), or nil.
func (lib library) courseOf(folderID *string) *libraryRow {
	seen := map[string]bool{}
	for current := folderID; current != nil && !seen[*current]; {
		seen[*current] = true
		folder, ok := lib.folders[*current]
		if !ok {
			return nil
		}
		if lib.isCourse(folder.ID) {
			return folder
		}
		current = folder.FolderID
	}
	return nil
}

func (lib library) outline(courseID string) string {
	lines := []string{}
	var walk func(folderID string, depth int)
	walk = func(folderID string, depth int) {
		files := []*libraryRow{}
		for _, file := range lib.files {
			if file.FolderID != nil && *file.FolderID == folderID && live(file) {
				files = append(files, file)
			}
		}
		sort.SliceStable(files, func(i, j int) bool { return files[i].Position < files[j].Position })
		for _, file := range files {
			lines = append(lines, strings.Repeat("  ", depth)+"- "+file.Name)
		}
		folders := []*libraryRow{}
		for _, folder := range lib.folders {
			if folder.FolderID != nil && *folder.FolderID == folderID && live(folder) {
				folders = append(folders, folder)
			}
		}
		sort.SliceStable(folders, func(i, j int) bool {
			if folders[i].Position != folders[j].Position {
				return folders[i].Position < folders[j].Position
			}
			return folders[i].ID < folders[j].ID
		})
		for _, folder := range folders {
			lines = append(lines, strings.Repeat("  ", depth)+"- "+folder.Name)
			walk(folder.ID, depth+1)
		}
	}
	walk(courseID, 0)
	return strings.Join(lines[:min(len(lines), 80)], "\n")
}

// courseLessonInput is what a lesson of a course is written from (src/lib/generation/course-lesson.ts).
func (srv *Server) courseLessonInput(ctx context.Context, userID string, lib library, row *libraryRow, meta map[string]any, pending string) string {
	course := lib.courseOf(row.FolderID)
	var kept struct {
		Description *string `json:"courseDescription"`
		Material    *string `json:"courseMaterial"`
	}
	if course != nil {
		_ = json.Unmarshal([]byte(srv.readPart(ctx, userID, course, "course")), &kept)
	}
	excerpt := pending
	if excerpt == "" && kept.Material != nil {
		excerpt = *kept.Material
	}
	parts := []string{"# " + row.Name}
	if description, _ := meta["description"].(string); description != "" {
		parts = append(parts, "Esta aula precisa cobrir: "+description)
	}
	if course != nil {
		parts = append(parts, "## Onde esta aula se encaixa\nCurso: "+course.Name)
		if kept.Description != nil && *kept.Description != "" {
			parts = append(parts, *kept.Description)
		}
		if structure := lib.outline(course.ID); structure != "" {
			parts = append(parts, "Estrutura do curso:\n"+structure)
		}
		parts = append(parts, "Escreva SÓ esta aula. Não repita o que pertence às outras aulas da lista acima.")
	}
	parts = append(parts, "## Material desta aula\n"+excerpt)
	return strings.Join(parts, "\n\n")
}

// writing is one note to write (the arguments of runOnFile).
type writing struct {
	agent, content, label, origin, system, pick, instruction string
	keepName                                                 bool
	// made: what the note keeps of this generation, written when it starts (nil: as it was)
	made map[string]any
	// noteType: the type the note becomes (the second tab: a recording that becomes an Ata or an Aula)
	noteType string
	// inside: one note of a job that writes many ("Gerar as aulas que faltam"): the job is ended by its caller
	inside bool
	// recording: the recording the note is written from (an Ata of another note); nil: the note's own
	recording *transcribe.Recording
}

// writeNote writes the note and keeps it; a failure leaves it "Pendente" with its material, saying why (runOnFile).
func (srv *Server) writeNote(ctx context.Context, start JobStart, userID, fileID string, w writing) error {
	_, _ = srv.db.Exec(`UPDATE jobs SET device_id = ? WHERE id = ?`, serverDevice, start.ID)
	row, err := findRow(srv.db, userID, fileID)
	if err != nil || row == nil || row.RemovedAt != nil {
		if w.inside {
			return errors.New("A nota não está mais lá.")
		}
		return srv.jobFailed(start, userID, "A nota não está mais lá.")
	}
	lib := srv.libraryOf(userID)
	activity := srv.startActivity(ctx, userID, map[string]any{"kind": w.agent, "label": w.label + ": " + row.Name, "origin": w.origin, "destination": destinationOf(lib.folders, row.FolderID), "fileId": fileID})
	kept := srv.sourcePart(ctx, userID, row)
	_ = srv.changeNote(userID, fileID, func(row *libraryRow, meta map[string]any) (string, bool) {
		meta["status"] = "generating"
		if w.made != nil {
			meta["made"] = w.made
		}
		if w.noteType != "" {
			kind := w.noteType
			row.NoteType = &kind
			meta["type"] = kind
		}
		return row.Name, true
	})
	fail := func(reason string) error {
		after := context.WithoutCancel(ctx)
		pending := w.content
		if kept.PendingExcerpt != nil {
			pending = *kept.PendingExcerpt
		}
		kept.PendingExcerpt = &pending
		if body, err := json.Marshal(kept); err == nil {
			_, _ = srv.writePart(after, userID, fileID, "source", body)
		}
		_ = srv.changeNote(userID, fileID, func(row *libraryRow, meta map[string]any) (string, bool) {
			meta["status"] = "pending"
			return row.Name, true
		})
		if ctx.Err() != nil {
			srv.finishActivity(after, userID, activity, "cancelled", "Cancelado por você.")
			return ctx.Err()
		}
		srv.finishActivity(after, userID, activity, "error", reason)
		if w.inside {
			return errors.New(reason)
		}
		return srv.jobFailed(start, userID, reason)
	}
	session := srv.session(w.pick, agentUse[w.agent])
	if session == nil {
		return fail("Nenhum modelo de IA do servidor escreve " + strings.ToLower(agentLabel[w.agent]) + ": escolha um em Configurações › Inteligência artificial.")
	}
	var recording *transcribe.Recording
	var transcript struct {
		Recording *transcribe.Recording `json:"recording"`
	}
	if json.Unmarshal([]byte(srv.readPart(ctx, userID, row, "transcript")), &transcript) == nil {
		recording = transcript.Recording
	}
	if w.recording != nil {
		recording = w.recording
	}
	writingAt := time.Now()
	markdown, name := "", ""
	if w.agent == "meeting" && w.system == "" {
		srv.jobSays(start.ID, userID, "Escrevendo a ata (duas passadas)", nil)
		written, subject, err := generate.Minutes(ctx, session.chat, w.content, recording, w.instruction)
		if err != nil {
			return fail(upper(err))
		}
		markdown, name = written, generate.MinutesFileName(subject, srv.now().In(brazil))
	} else {
		says := "Escrevendo a explicação"
		if w.agent == "lesson" {
			says = "Escrevendo a aula"
		}
		srv.jobSays(start.ID, userID, says, nil)
		system := w.system
		if system == "" {
			system = prompts.Text(agentPrompt[w.agent])
		}
		written, err := generate.Content(ctx, session.chat, generate.WithInstruction(w.content, w.instruction), system)
		if err != nil {
			return fail(upper(err))
		}
		markdown = written
	}
	stages := []transcribe.Stage{{Name: "Escrever", MS: time.Since(writingAt).Milliseconds()}}
	srv.jobSays(start.ID, userID, "Salvando", nil)
	if _, err := srv.writePart(ctx, userID, fileID, "text", []byte(markdown)); err != nil {
		return fail("A nota não foi guardada: " + err.Error())
	}
	kept.PendingExcerpt = nil
	if body, err := json.Marshal(kept); err == nil {
		_, _ = srv.writePart(ctx, userID, fileID, "source", body)
	}
	if err := srv.changeNoteNamed(userID, fileID, func(row *libraryRow, meta map[string]any) (string, bool) {
		meta["status"], meta["generation"], meta["words"], meta["readingMinutes"], meta["updated"] = "ready", session.meta(srv.now(), stages), wordCount(markdown), readingMinutes(markdown), srv.stamp()
		if name != "" && !w.keepName {
			return name, true
		}
		return row.Name, true
	}); err != nil {
		return fail("A nota não foi guardada: " + err.Error())
	}
	srv.finishActivity(ctx, userID, activity, "done", "Pronta e salva na Biblioteca.")
	srv.logf("jobs: %s %s no Go: %.1f s, US$ %.4f", start.ID, w.label, time.Since(session.started).Seconds(), session.cost)
	if !w.inside {
		srv.jobEnds(start.ID, userID, `state = 'done', fraction = 1, stage = ?, last_progress = ?, stalled_since = NULL`, "Pronta e salva na Biblioteca.", "Pronta e salva na Biblioteca.")
	}
	srv.suggestTagsOf(context.WithoutCancel(ctx), userID, fileID)
	return nil
}

// suggestTagsOf keeps up to 4 tags the note does not have yet as suggestions (suggestTagsFor); a failure changes nothing.
func (srv *Server) suggestTagsOf(ctx context.Context, userID, fileID string) {
	row, err := findRow(srv.db, userID, fileID)
	if err != nil || row == nil {
		return
	}
	chat := srv.chatFor("titulo", "estudo", nil)
	if chat == nil {
		return
	}
	suggested, err := generate.Tags(ctx, chat, srv.noteText(ctx, userID, row), srv.knownTags(userID))
	if err != nil || len(suggested) == 0 {
		return
	}
	_ = srv.changeNote(userID, fileID, func(row *libraryRow, meta map[string]any) (string, bool) {
		has := map[string]bool{}
		for _, tag := range stringsOf(meta["tags"]) {
			has[tag] = true
		}
		fresh := []string{}
		for _, tag := range suggested {
			if !has[tag] {
				fresh = append(fresh, tag)
			}
		}
		if len(fresh) == 0 {
			return row.Name, false
		}
		meta["suggestedTags"] = fresh
		return row.Name, true
	})
}

// pendingPlan is "Gerar agora" of a note (pendingOf): its agent, what it is written from; nil when it needs what only the app reads
// (a link of its source).
func (srv *Server) pendingPlan(ctx context.Context, userID, fileID, pick string, instruction *string) *writing {
	row, err := findRow(srv.db, userID, fileID)
	if err != nil || row == nil || row.RemovedAt != nil {
		return nil
	}
	var meta map[string]any
	_ = json.Unmarshal(row.Meta, &meta)
	lib := srv.libraryOf(userID)
	course := lib.courseOf(row.FolderID) != nil
	agent := "lesson"
	if !course && row.NoteType != nil {
		switch *row.NoteType {
		case "explanation":
			agent = "explanation"
		case "meeting":
			agent = "meeting"
		}
	}
	said := ""
	if instruction != nil {
		said = *instruction
	} else if made, ok := meta["made"].(map[string]any); ok {
		said, _ = made["instruction"].(string)
	}
	plan := &writing{agent: agent, pick: pick, instruction: said, made: srv.choiceOf(agentUse[agent], pick, said)}
	kept := srv.sourcePart(ctx, userID, row)
	pending := ""
	if kept.PendingExcerpt != nil {
		pending = *kept.PendingExcerpt
	}
	if course {
		name, _ := meta["description"].(string)
		if name == "" {
			name = row.Name
		}
		plan.content, plan.label, plan.origin = srv.courseLessonInput(ctx, userID, lib, row, meta, pending), "Aula", name
		return plan
	}
	origin, _ := meta["origin"].(map[string]any)
	plan.label = "Nova tentativa"
	plan.origin = row.Name
	if url, _ := origin["url"].(string); url != "" {
		plan.origin = url
	} else if name, _ := origin["name"].(string); name != "" {
		plan.origin = name
	}
	if kept.PendingExcerpt != nil {
		plan.content = pending
		return plan
	}
	source, hasSource := meta["source"].(map[string]any)
	if !hasSource {
		plan.content = "# " + row.Name
		return plan
	}
	text := ""
	if kept.SourceText != nil {
		text = *kept.SourceText
	} else {
		text, _ = source["text"].(string)
	}
	switch source["kind"] {
	case "text":
		if strings.TrimSpace(text) != "" {
			plan.content = "# Conteúdo\n\n" + strings.TrimSpace(text)
			return plan
		}
	case "topic":
		if strings.TrimSpace(text) != "" {
			plan.content = strings.TrimSpace(text)
			return plan
		}
	}
	// a link is read by the app (pages, PDFs, videos)
	return nil
}

// regeneratePlan is "Gerar de novo" of a written note (regenerate): the note written again from its own text.
func (srv *Server) regeneratePlan(ctx context.Context, userID, fileID string) (*writing, bool) {
	row, err := findRow(srv.db, userID, fileID)
	if err != nil || row == nil || row.RemovedAt != nil {
		return nil, false
	}
	var meta map[string]any
	_ = json.Unmarshal(row.Meta, &meta)
	kept := srv.sourcePart(ctx, userID, row)
	_, hasOrigin := meta["origin"].(map[string]any)
	if (kept.PendingExcerpt != nil && *kept.PendingExcerpt != "") || (meta["status"] == "pending" && !hasOrigin) {
		return nil, true
	}
	kind := ""
	if row.NoteType != nil {
		kind = *row.NoteType
	}
	agent, system := "lesson", prompts.Text("LESSON_PROMPT")
	switch kind {
	case "explanation":
		agent, system = "explanation", prompts.Text("EXPLANATION_PROMPT")
	case "meeting":
		system = prompts.Text("MEETING_PROMPT")
	}
	return &writing{agent: agent, content: "# " + row.Name + "\n\n" + srv.readPart(ctx, userID, row, "text"), label: "Nova versão", origin: row.Name, system: system}, false
}

var fileTypeOf = map[string]string{"lesson": "class", "explanation": "explanation", "meeting": "meeting", "reading": "reading"}

// secondTabPlan: a recording that becomes an Ata or an Aula (generateSecondTab), written from its transcription.
func (srv *Server) secondTabPlan(ctx context.Context, userID, fileID, agent, pick, instruction string) *writing {
	row, err := findRow(srv.db, userID, fileID)
	if err != nil || row == nil || row.RemovedAt != nil || agentLabel[agent] == "" {
		return nil
	}
	var transcript struct {
		Recording *transcribe.Recording `json:"recording"`
	}
	if json.Unmarshal([]byte(srv.readPart(ctx, userID, row, "transcript")), &transcript) != nil || transcript.Recording == nil {
		return nil
	}
	var meta map[string]any
	_ = json.Unmarshal(row.Meta, &meta)
	origin := row.Name
	if from, ok := meta["origin"].(map[string]any); ok {
		if name, _ := from["name"].(string); name != "" {
			origin = name
		}
	}
	return &writing{agent: agent, content: "# Conteúdo\n\n" + transcribe.TranscriptText(transcript.Recording.Blocks, transcript.Recording.Speakers), label: agentLabel[agent], origin: origin, pick: pick, instruction: instruction,
		made: srv.choiceOf(agentUse[agent], pick, instruction), noteType: fileTypeOf[agent]}
}

// runRedo: "Refazer a transcrição" (redoTranscript): the corrections in the transcription; a note read as its transcription gets the
// new text.
func (srv *Server) runRedo(ctx context.Context, start JobStart, userID, fileID, instruction, pick string) error {
	_, _ = srv.db.Exec(`UPDATE jobs SET device_id = ? WHERE id = ?`, serverDevice, start.ID)
	row, err := findRow(srv.db, userID, fileID)
	if err != nil || row == nil || row.RemovedAt != nil {
		return srv.jobFailed(start, userID, "A nota não está mais lá.")
	}
	var transcript map[string]json.RawMessage
	var kept struct {
		Recording *transcribe.Recording `json:"recording"`
	}
	raw := srv.readPart(ctx, userID, row, "transcript")
	if json.Unmarshal([]byte(raw), &transcript) != nil || json.Unmarshal([]byte(raw), &kept) != nil || kept.Recording == nil {
		srv.jobEnds(start.ID, userID, `state = 'done', fraction = 1, stage = ?, last_progress = ?, stalled_since = NULL`, "Pronto.", "Pronto.")
		return nil
	}
	srv.jobSays(start.ID, userID, "Refazendo a transcrição", nil)
	session := srv.session(pick, "estudo")
	if session == nil {
		return srv.jobFailed(start, userID, "Nenhum modelo de IA do servidor refaz a transcrição: escolha um em Configurações › Inteligência artificial.")
	}
	_, terms := srv.accountSettings(ctx, userID)
	chat := func(ctx context.Context, user, system string) (string, error) {
		return session.chat(ctx, user, system, 0)
	}
	redone, err := transcribe.RedoTranscript(ctx, *kept.Recording, instruction, chat, terms)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return srv.jobFailed(start, userID, upper(err))
	}
	// the recording changes and everything else of the part stays as it was
	var recording map[string]json.RawMessage
	_ = json.Unmarshal(transcript["recording"], &recording)
	blocks, _ := json.Marshal(redone.Blocks)
	speakers, _ := json.Marshal(redone.Speakers)
	recording["blocks"], recording["speakers"] = blocks, speakers
	transcript["recording"], _ = json.Marshal(recording)
	body, _ := json.Marshal(transcript)
	if _, err := srv.writePart(ctx, userID, fileID, "transcript", body); err != nil {
		return srv.jobFailed(start, userID, "A transcrição refeita não foi guardada: "+err.Error())
	}
	var meta map[string]any
	_ = json.Unmarshal(row.Meta, &meta)
	origin, _ := meta["origin"].(map[string]any)
	input, _ := origin["input"].(string)
	mime, _ := origin["mime"].(string)
	kind := ""
	if row.NoteType != nil {
		kind = *row.NoteType
	}
	// readsAsTranscript: a Leitura, or a note of media (Vídeo, Áudio; an old entrada of a recording or of a media file)
	media := kind == "audio" || kind == "video" || (meta["role"] == "entrada" && (input == "recording" || strings.HasPrefix(mime, "audio/") || strings.HasPrefix(mime, "video/")))
	if kind == "reading" || media {
		text := strings.TrimSpace(transcribe.TranscriptText(redone.Blocks, redone.Speakers))
		if _, err := srv.writePart(ctx, userID, fileID, "text", []byte(text)); err != nil {
			return srv.jobFailed(start, userID, "O texto refeito não foi guardado: "+err.Error())
		}
		_ = srv.changeNote(userID, fileID, func(row *libraryRow, meta map[string]any) (string, bool) {
			meta["words"], meta["readingMinutes"], meta["updated"] = wordCount(text), readingMinutes(text), srv.stamp()
			return row.Name, true
		})
	}
	srv.jobEnds(start.ID, userID, `state = 'done', fraction = 1, stage = ?, last_progress = ?, stalled_since = NULL`, "Transcrição refeita.", "Transcrição refeita.")
	return nil
}

// remainingIn are the lessons still pending in a folder and the folders inside it.
func (lib library) remainingIn(folderID string) []*libraryRow {
	ids := map[string]bool{folderID: true}
	for grew := true; grew; {
		grew = false
		for _, folder := range lib.folders {
			if folder.FolderID != nil && ids[*folder.FolderID] && !ids[folder.ID] {
				ids[folder.ID], grew = true, true
			}
		}
	}
	out := []*libraryRow{}
	for _, file := range lib.files {
		var meta map[string]any
		_ = json.Unmarshal(file.Meta, &meta)
		if file.FolderID != nil && ids[*file.FolderID] && meta["status"] == "pending" && live(file) {
			out = append(out, file)
		}
	}
	return out
}

// runRemaining: "Gerar as aulas que faltam" (generateRemaining): every pending lesson of the course, at once; the job ends when all
// were written, failing with the reasons of the ones that were not.
func (srv *Server) runRemaining(ctx context.Context, start JobStart, userID string, plans map[string]writing) error {
	_, _ = srv.db.Exec(`UPDATE jobs SET device_id = ? WHERE id = ?`, serverDevice, start.ID)
	srv.jobSays(start.ID, userID, fmt.Sprintf("Gerando as aulas que faltam · %d", len(plans)), nil)
	var mu sync.Mutex
	failed := []string{}
	var wg sync.WaitGroup
	for fileID, plan := range plans {
		wg.Add(1)
		go func(fileID string, plan writing) {
			defer wg.Done()
			plan.inside = true
			if err := srv.writeNote(ctx, start, userID, fileID, plan); err != nil && ctx.Err() == nil {
				mu.Lock()
				failed = append(failed, err.Error())
				mu.Unlock()
			}
		}(fileID, plan)
	}
	wg.Wait()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if len(failed) > 0 {
		return srv.jobFailed(start, userID, fmt.Sprintf("%d de %d aulas não saíram: %s", len(failed), len(plans), failed[0]))
	}
	srv.jobEnds(start.ID, userID, `state = 'done', fraction = 1, stage = ?, last_progress = ?, stalled_since = NULL`, "Pronta e salva na Biblioteca.", "Pronta e salva na Biblioteca.")
	return nil
}
