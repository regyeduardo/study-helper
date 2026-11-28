package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/regyeduardo/study-helper/api/internal/generate"
	"github.com/regyeduardo/study-helper/api/internal/transcribe"
)

// T207 (dono, 28/11: "Desapareça com esse node do backend"; FR-084): the generations asked in the account run in the backend in Go, one
// call at a time as each one passes its tests; the calls not yet here still go to the Chromium.

// goGenerationOf is the runner in Go of a job's call, or nil.
func (srv *Server) goGenerationOf(id, userID string) func(ctx context.Context, start JobStart) error {
	var call, request string
	if err := srv.db.QueryRow(`SELECT call, request FROM jobs WHERE id = ?`, id).Scan(&call, &request); err != nil {
		return nil
	}
	var asked struct {
		Args []json.RawMessage `json:"args"`
	}
	if json.Unmarshal([]byte(request), &asked) != nil {
		return nil
	}
	text := func(index int) string {
		var out string
		if index < len(asked.Args) {
			_ = json.Unmarshal(asked.Args[index], &out)
		}
		return out
	}
	switch call {
	case "suggestTags":
		fileID := text(0)
		return func(ctx context.Context, start JobStart) error { return srv.runTags(ctx, start, userID, fileID) }
	case "generateArtifact":
		var req artifactRequest
		if len(asked.Args) > 0 {
			_ = json.Unmarshal(asked.Args[0], &req)
		}
		if req.Artifact != "mapa" && req.Artifact != "cartoes" {
			return nil
		}
		// the old single map or deck of a note (the part `documents`) is migrated by the app, which still makes these
		if row, err := findRow(srv.db, userID, req.FileID); err == nil && row != nil && row.Parts["documents"] != "" {
			return nil
		}
		return func(ctx context.Context, start JobStart) error { return srv.runArtifact(ctx, start, userID, req) }
	case "generatePending":
		fileID, model := text(0), text(1)
		var instruction *string
		if len(asked.Args) > 2 && string(asked.Args[2]) != "null" {
			said := text(2)
			instruction = &said
		}
		plan := srv.pendingPlan(context.Background(), userID, fileID, model, instruction)
		if plan == nil {
			return nil
		}
		return func(ctx context.Context, start JobStart) error {
			return srv.writeNote(ctx, start, userID, fileID, *plan)
		}
	case "regenerate":
		fileID := text(0)
		plan, pending := srv.regeneratePlan(context.Background(), userID, fileID)
		if pending {
			plan = srv.pendingPlan(context.Background(), userID, fileID, "", nil)
		}
		if plan == nil {
			return nil
		}
		return func(ctx context.Context, start JobStart) error {
			return srv.writeNote(ctx, start, userID, fileID, *plan)
		}
	case "generateSecondTab":
		fileID, agent, model, instruction := text(0), text(1), text(2), text(3)
		plan := srv.secondTabPlan(context.Background(), userID, fileID, agent, model, instruction)
		if plan == nil {
			return nil
		}
		return func(ctx context.Context, start JobStart) error {
			return srv.writeNote(ctx, start, userID, fileID, *plan)
		}
	case "redoTranscript":
		fileID, instruction, model := text(0), text(1), text(2)
		return func(ctx context.Context, start JobStart) error {
			return srv.runRedo(ctx, start, userID, fileID, instruction, model)
		}
	case "generateRemaining":
		folderID, model := text(0), text(1)
		var instruction *string
		if len(asked.Args) > 2 && string(asked.Args[2]) != "null" {
			said := text(2)
			instruction = &said
		}
		plans := map[string]writing{}
		for _, file := range srv.libraryOf(userID).remainingIn(folderID) {
			plan := srv.pendingPlan(context.Background(), userID, file.ID, model, instruction)
			if plan == nil {
				// a lesson the app has to read first: the whole job goes to it
				return nil
			}
			plans[file.ID] = *plan
		}
		return func(ctx context.Context, start JobStart) error { return srv.runRemaining(ctx, start, userID, plans) }
	case "explainSelection":
		req := explainRequest{fileID: text(0), excerpt: text(1), prompt: text(2), mode: text(3), model: text(4)}
		if len(asked.Args) > 5 {
			var place struct {
				FolderID *string `json:"folderId"`
				Replace  *string `json:"replace"`
			}
			if string(asked.Args[5]) == `"home"` {
				req.home = true
			} else if json.Unmarshal(asked.Args[5], &place) == nil {
				req.folderID, req.replace = place.FolderID, place.Replace
			}
		}
		return func(ctx context.Context, start JobStart) error { return srv.runExplain(ctx, start, userID, req) }
	case "generateFromSelection":
		fileID, excerpt, agent, model, instruction := text(0), text(1), text(2), text(3), text(5)
		// a link is read by the app (the page, the PDF, the video)
		if linkIn(excerpt) != "" || agentLabel[agent] == "" {
			return nil
		}
		var place *struct {
			FolderID *string `json:"folderId"`
		}
		if len(asked.Args) > 4 {
			_ = json.Unmarshal(asked.Args[4], &place)
		}
		return func(ctx context.Context, start JobStart) error {
			return srv.runFromSelection(ctx, start, userID, fileID, excerpt, agent, model, place != nil, func() *string {
				if place != nil {
					return place.FolderID
				}
				return nil
			}(), instruction)
		}
	case "generateFromNote":
		return srv.fromNotePlan(context.Background(), userID, asked.Args)
	case "createQuestions":
		fileID, model, instruction := text(0), text(2), text(3)
		var wrong []generate.Wrong
		if len(asked.Args) > 1 {
			_ = json.Unmarshal(asked.Args[1], &wrong)
		}
		return func(ctx context.Context, start JobStart) error {
			return srv.runExam(ctx, start, userID, fileID, wrong, model, instruction)
		}
	}
	return nil
}

// spending adds up what a job cost, from calls made at once.
type jobSpending struct {
	mu  sync.Mutex
	usd float64
}

func (s *jobSpending) add(usd float64) {
	s.mu.Lock()
	s.usd += usd
	s.mu.Unlock()
}

// chatFor is the AI of a use (or of the use it inherits from) with the server's keys; nil when there is none.
func (srv *Server) chatFor(use, from string, spend func(float64)) generate.Chat {
	return srv.chatPicked("", use, from, spend)
}

// chatPicked is the model picked at the time (a uid), or else the one of the use.
func (srv *Server) chatPicked(pick, use, from string, spend func(float64)) generate.Chat {
	choice := srv.aiChoice()
	uid := pick
	if provider, _ := choice.target(uid); provider == "" {
		uid = choice.uidFor(use, from)
	}
	provider, model := choice.target(uid)
	cfg := srv.goAI()
	if provider == "" || cfg.Asks(provider) != nil {
		return nil
	}
	return generate.Chat(cfg.ChatLimit(provider, model, spend))
}

// noteText is what a note says: its text, or the text of its transcription.
func (srv *Server) noteText(ctx context.Context, userID string, row *libraryRow) string {
	if text := strings.TrimSpace(srv.readPart(ctx, userID, row, "text")); text != "" {
		return text
	}
	var transcript struct {
		Recording *transcribe.Recording `json:"recording"`
	}
	if json.Unmarshal([]byte(srv.readPart(ctx, userID, row, "transcript")), &transcript) == nil && transcript.Recording != nil {
		return transcribe.TranscriptText(transcript.Recording.Blocks, transcript.Recording.Speakers)
	}
	return ""
}

func stringsOf(value any) []string {
	list, _ := value.([]any)
	out := []string{}
	for _, item := range list {
		if text, ok := item.(string); ok {
			out = append(out, text)
		}
	}
	return out
}

// knownTags are the tags of all the account's notes, in the order first seen.
func (srv *Server) knownTags(userID string) []string {
	rows, err := srv.read.Query(`SELECT meta FROM library_items WHERE user_id = ? AND item_kind = 'file' AND removed_at IS NULL ORDER BY position, id`, userID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	seen := map[string]bool{}
	out := []string{}
	for rows.Next() {
		var raw []byte
		var meta map[string]any
		if rows.Scan(&raw) != nil || json.Unmarshal(raw, &meta) != nil {
			continue
		}
		for _, tag := range stringsOf(meta["tags"]) {
			if !seen[tag] {
				seen[tag] = true
				out = append(out, tag)
			}
		}
	}
	return out
}

// changeNote changes the meta (and the name) of a note over whatever revision it is at; `change` false: nothing to write.
func (srv *Server) changeNote(userID, fileID string, change func(row *libraryRow, meta map[string]any) (string, bool)) error {
	for round := 0; round < 4; round++ {
		row, err := findRow(srv.db, userID, fileID)
		if err != nil || row == nil || row.RemovedAt != nil {
			return errors.New("a nota não está mais lá")
		}
		var meta map[string]any
		if json.Unmarshal(row.Meta, &meta) != nil || meta == nil {
			meta = map[string]any{}
		}
		name, ok := change(row, meta)
		if !ok {
			return nil
		}
		raw, _ := json.Marshal(meta)
		place := "app"
		if row.Place != nil {
			place = *row.Place
		}
		fields := rowFields{ItemKind: row.ItemKind, NoteType: row.NoteType, Name: name, FolderID: row.FolderID, ParentFileID: row.ParentFileID, Place: place, Recording: row.Recording, Position: row.Position, Meta: raw, DriveRef: row.DriveRef, CreatedAt: row.CreatedAt, UpdatedAt: ts(srv.now()), TrashedAt: row.TrashedAt, TrashedWith: row.TrashedWith}
		tx, err := srv.db.Begin()
		if err != nil {
			return err
		}
		seq, err := nextSeq(tx, userID)
		if err == nil {
			_, err = srv.applyRow(tx, userID, fileID, row.Rev, fields, seq, true)
		}
		var stale *rowError
		if errors.As(err, &stale) && stale.code == "conflict" {
			_ = tx.Rollback()
			continue
		}
		if err != nil {
			_ = tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
		srv.notifyMap(userID, seq)
		return nil
	}
	return errors.New("a nota mudou ao mesmo tempo; tente de novo")
}

// runTags: "Sugerir etiquetas" (src/stores/jobs.ts, suggestTagsFor): up to 4 tags the note does not have yet, kept as suggestions.
func (srv *Server) runTags(ctx context.Context, start JobStart, userID, fileID string) error {
	_, _ = srv.db.Exec(`UPDATE jobs SET device_id = ? WHERE id = ?`, serverDevice, start.ID)
	row, err := findRow(srv.db, userID, fileID)
	if err != nil || row == nil || row.RemovedAt != nil {
		srv.jobEnds(start.ID, userID, `state = 'failed', error = ?, error_code = 'internal'`, "A nota não está mais lá.")
		return errors.New("no note")
	}
	srv.jobSays(start.ID, userID, "Sugerindo etiquetas", nil)
	spent := &jobSpending{}
	suggested := []string{}
	if chat := srv.chatFor("titulo", "estudo", spent.add); chat != nil {
		tags, err := generate.Tags(ctx, chat, srv.noteText(ctx, userID, row), srv.knownTags(userID))
		if err != nil {
			return ctx.Err()
		}
		suggested = tags
	}
	if err := srv.changeNote(userID, fileID, func(row *libraryRow, meta map[string]any) (string, bool) {
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
	}); err != nil {
		srv.jobEnds(start.ID, userID, `state = 'failed', error = ?, error_code = 'internal'`, "As etiquetas não foram guardadas: "+err.Error())
		return err
	}
	srv.jobEnds(start.ID, userID, `state = 'done', fraction = 1, stage = ?, last_progress = ?, stalled_since = NULL`, "Pronto.", "Pronto.")
	return nil
}

// artifactRequest is what "Mapa mental" and "Cartões" ask (src/stores/jobs.ts, generateArtifact).
type artifactRequest struct {
	FileID      string `json:"fileId"`
	Artifact    string `json:"artifact"`
	Model       string `json:"model"`
	Instruction string `json:"instruction"`
	Again       string `json:"again"`
	Replace     bool   `json:"replace"`
}

var artifactWords = map[string]struct{ busy, empty, failed, placeholder string }{
	"mapa":    {"Desenhando o mapa da nota", "A IA não devolveu um mapa. Tente de novo.", "O mapa não saiu.", "Mapa mental"},
	"cartoes": {"Fazendo os cartões da nota", "A IA não devolveu nenhum cartão. Tente de novo.", "Os cartões não saíram.", "Cartões"},
}

// isoNow is the time as the app writes it (new Date().toISOString()).
func isoNow(now time.Time) string { return now.UTC().Format("2006-01-02T15:04:05.000Z") }

// brazil is the time of the names the app gives in the person's own time ("Mapa mental · 28/11 14:05").
var brazil = func() *time.Location {
	if place, err := time.LoadLocation("America/Sao_Paulo"); err == nil {
		return place
	}
	return time.FixedZone("BRT", -3*3600)
}()

// studyText is what a map or a deck is made from: the transcription of a recording, else the note's text.
func (srv *Server) studyText(ctx context.Context, userID string, row *libraryRow) string {
	var transcript struct {
		Recording *transcribe.Recording `json:"recording"`
	}
	if json.Unmarshal([]byte(srv.readPart(ctx, userID, row, "transcript")), &transcript) == nil && transcript.Recording != nil && len(transcript.Recording.Blocks) > 0 {
		return transcribe.TranscriptText(transcript.Recording.Blocks, transcript.Recording.Speakers)
	}
	return srv.readPart(ctx, userID, row, "text")
}

// jobFailed ends a job the server ran with the reason, in words for the person.
func (srv *Server) jobFailed(start JobStart, userID, reason string) error {
	srv.jobEnds(start.ID, userID, `state = 'failed', error = ?, error_code = 'internal'`, reason)
	return errors.New(reason)
}

func upper(err error) string { return upperFirst(err.Error()) }

// runArtifact: a mind map or a deck of the note (src/stores/jobs.ts, generateArtifact), kept as the app keeps them: the part
// `artifacts/<id>` and, in the note's meta, the list, the due cards and whether it has a map. The job gives the artifact back.
func (srv *Server) runArtifact(ctx context.Context, start JobStart, userID string, asked artifactRequest) error {
	_, _ = srv.db.Exec(`UPDATE jobs SET device_id = ? WHERE id = ?`, serverDevice, start.ID)
	words := artifactWords[asked.Artifact]
	row, err := findRow(srv.db, userID, asked.FileID)
	if err != nil || row == nil || row.RemovedAt != nil {
		return srv.jobFailed(start, userID, "A nota não está mais lá.")
	}
	srv.jobSays(start.ID, userID, words.busy, nil)
	spent := &jobSpending{}
	chat := srv.chatPicked(asked.Model, asked.Artifact, "estudo", spent.add)
	if chat == nil {
		return srv.jobFailed(start, userID, words.failed+" Nenhum modelo de IA do servidor faz "+strings.ToLower(words.placeholder)+": escolha um em Configurações › Inteligência artificial.")
	}
	var before map[string]any
	if asked.Again != "" {
		if json.Unmarshal([]byte(srv.readPart(ctx, userID, row, "artifacts/"+asked.Again)), &before) != nil || before["kind"] != asked.Artifact {
			before = nil
		}
	}
	said := strings.TrimSpace(asked.Instruction)
	text := srv.studyText(ctx, userID, row)
	now := srv.now()
	artifact := map[string]any{"id": generate.NewID(), "kind": asked.Artifact}
	name := ""
	switch asked.Artifact {
	case "mapa":
		named, diagram, err := generate.Map(ctx, chat, text, said)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return srv.jobFailed(start, userID, upper(err))
		}
		if diagram == nil {
			return srv.jobFailed(start, userID, words.empty)
		}
		name = named
		artifact["diagram"], artifact["versions"], artifact["chat"] = diagram, []any{}, []any{}
	default:
		cards, named, err := generate.Cards(ctx, chat, text, said, generate.Today(now))
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return srv.jobFailed(start, userID, upper(err))
		}
		if len(cards) == 0 {
			return srv.jobFailed(start, userID, words.empty)
		}
		name = named
		artifact["cards"] = cards
	}
	// "Substituir este": its place and id, its name unless it still has the placeholder
	if asked.Replace && before != nil {
		artifact["id"] = before["id"]
		if provisional, _ := before["provisionalName"].(bool); !provisional {
			if kept, _ := before["name"].(string); kept != "" {
				name = kept
			}
		}
	}
	stamp := isoNow(now)
	if name = strings.TrimSpace(name); name != "" {
		artifact["name"] = name
	} else {
		local := now.In(brazil)
		artifact["name"] = fmt.Sprintf("%s · %02d/%02d %02d:%02d", words.placeholder, local.Day(), int(local.Month()), local.Hour(), local.Minute())
		artifact["provisionalName"] = true
	}
	artifact["createdAt"], artifact["updatedAt"] = stamp, stamp
	made := map[string]any{"at": stamp}
	if asked.Model != "" {
		made["model"] = asked.Model
	}
	if said != "" {
		made["instruction"] = said
	}
	artifact["made"] = made
	id, _ := artifact["id"].(string)
	body, _ := json.Marshal(artifact)
	if _, err := srv.writePart(ctx, userID, asked.FileID, "artifacts/"+id, body); err != nil {
		return srv.jobFailed(start, userID, words.failed+" Não foi guardado na nota: "+err.Error())
	}
	if err := srv.changeNote(userID, asked.FileID, func(row *libraryRow, meta map[string]any) (string, bool) {
		summary := map[string]any{"id": id, "kind": asked.Artifact, "name": artifact["name"], "updatedAt": stamp}
		list := []any{}
		placed := false
		for _, item := range asListOfMaps(meta["artifacts"]) {
			if item["id"] == id {
				list, placed = append(list, summary), true
				continue
			}
			list = append(list, item)
		}
		if !placed {
			list = append(list, summary)
		}
		due := []string{}
		mindmap := false
		for _, item := range list {
			entry, _ := item.(map[string]any)
			switch entry["kind"] {
			case "mapa":
				mindmap = true
			case "cartoes":
				var deck struct {
					Cards []generate.Card `json:"cards"`
				}
				raw := string(body)
				if entry["id"] != id {
					raw = srv.readPart(ctx, userID, row, "artifacts/"+fmt.Sprint(entry["id"]))
				}
				if json.Unmarshal([]byte(raw), &deck) == nil {
					for _, card := range deck.Cards {
						due = append(due, card.Due)
					}
				}
			}
		}
		meta["artifacts"], meta["cardDue"], meta["hasMindmap"] = list, due, mindmap
		return row.Name, true
	}); err != nil {
		return srv.jobFailed(start, userID, words.failed+" A lista da nota não foi atualizada: "+err.Error())
	}
	srv.jobEnds(start.ID, userID, `state = 'done', result = ?, fraction = 1, stage = ?, last_progress = ?, stalled_since = NULL`, string(body), fmt.Sprintf("Pronto: “%s”.", artifact["name"]), "Pronto.")
	return nil
}

func asListOfMaps(value any) []map[string]any {
	list, _ := value.([]any)
	out := []map[string]any{}
	for _, item := range list {
		if row, ok := item.(map[string]any); ok {
			out = append(out, row)
		}
	}
	return out
}

// changeIndex changes the account's library index (activities, as the app's saveIndex does) over whatever version it is at.
func (srv *Server) changeIndex(ctx context.Context, userID string, change func(index map[string]any) bool) error {
	for round := 0; round < 4; round++ {
		var base string
		var oldBytes int64
		_ = srv.db.QueryRow(`SELECT version, bytes FROM library_index WHERE user_id = ?`, userID).Scan(&base, &oldBytes)
		// an account without its index yet: the app makes it (an index with only this change would lack the rest)
		if base == "" {
			return nil
		}
		index := map[string]any{}
		reader, _, err := srv.cfg.Blobs.Get(ctx, indexKey(userID, base), nil)
		if err != nil {
			return err
		}
		err = json.NewDecoder(reader).Decode(&index)
		reader.Close()
		if err != nil {
			return err
		}
		if !change(index) {
			return nil
		}
		body, _ := json.Marshal(index)
		if hasKey(index) {
			return errors.New("o índice levaria uma chave")
		}
		version := srv.newVersion()
		if err := srv.cfg.Blobs.Put(ctx, indexKey(userID, version), body, "application/json", map[string]string{"user": userID, "part": "index"}); err != nil {
			return err
		}
		tx, err := srv.db.Begin()
		if err != nil {
			return err
		}
		var now string
		_ = tx.QueryRow(`SELECT version FROM library_index WHERE user_id = ?`, userID).Scan(&now)
		if now != base {
			_ = tx.Rollback()
			_ = srv.cfg.Blobs.Delete(ctx, indexKey(userID, version))
			continue
		}
		size := int64(len(body))
		_, err = tx.Exec(`INSERT INTO library_index (user_id, version, bytes, updated_at) VALUES (?, ?, ?, ?)
			ON CONFLICT (user_id) DO UPDATE SET version = excluded.version, bytes = excluded.bytes, updated_at = excluded.updated_at`, userID, version, size, ts(srv.now()))
		if err == nil {
			_, err = tx.Exec(`UPDATE user SET notes_bytes = MAX(0, notes_bytes + ?) WHERE id = ?`, size-oldBytes, userID)
		}
		if err == nil {
			err = orphan(tx, userID, indexKey(userID, base), "replaced", srv.now())
		}
		if err != nil {
			_ = tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
		srv.notifySpace(userID)
		return nil
	}
	return errors.New("o índice mudou ao mesmo tempo")
}

const activitiesKept = 300

// startActivity writes a running activity in the index (the app's startActivity); "" when the index could not take it (as in the app,
// that never stops the work).
func (srv *Server) startActivity(ctx context.Context, userID string, fields map[string]any) string {
	id := generate.NewID()
	activity := map[string]any{"id": id, "status": "running", "detail": "", "createdAt": isoNow(srv.now()), "finishedAt": nil, "deviceId": serverDevice}
	for key, value := range fields {
		activity[key] = value
	}
	if srv.changeIndex(ctx, userID, func(index map[string]any) bool {
		list, _ := index["activities"].([]any)
		list = append([]any{activity}, list...)
		index["activities"] = list[:min(len(list), activitiesKept)]
		index["updated"] = isoNow(srv.now())
		return true
	}) != nil {
		return ""
	}
	return id
}

// finishActivity closes the activity with how it ended.
func (srv *Server) finishActivity(ctx context.Context, userID, id, status, detail string) {
	if id == "" {
		return
	}
	_ = srv.changeIndex(ctx, userID, func(index map[string]any) bool {
		list, _ := index["activities"].([]any)
		for _, item := range list {
			if activity, ok := item.(map[string]any); ok && activity["id"] == id {
				activity["status"], activity["detail"], activity["finishedAt"] = status, detail, isoNow(srv.now())
			}
		}
		index["updated"] = isoNow(srv.now())
		return true
	})
}

// webSearchFor is the Questões da web model (only one chosen for that use: the server cannot tell whether the Estudo model searches),
// and why there is none when it cannot search.
func (srv *Server) webSearchFor(spend func(float64)) (generate.WebSearch, string) {
	choice := srv.aiChoice()
	uid := choice.Defaults["web"]
	provider, model := choice.target(uid)
	if provider == "" {
		return nil, ""
	}
	cfg := srv.goAI()
	if cfg.Asks(provider) != nil {
		return nil, fmt.Sprintf("Sem questões da web: o servidor não pesquisa na web com %s (%s). A prova saiu só com questões criadas pela IA.", model, provider)
	}
	extra := map[string]any{"web_search_options": map[string]any{}, "temperature": nil}
	if provider == "openrouter" {
		extra = map[string]any{"plugins": []map[string]string{{"id": "web"}}, "temperature": nil}
	}
	ask := cfg.Asker(provider, model, spend)
	return func(ctx context.Context, subject string) (string, error) {
		return ask(ctx, subject, generate.WebQuestionsPrompt(), transcribe.AskOptions{MaxTokens: 32768, Extra: extra})
	}, ""
}

// goAI is the AI of the server, for the requests made here.
func (srv *Server) goAI() transcribe.Config {
	cfg := transcribe.Config{Keys: srv.cfg.AI.Keys, Origins: srv.cfg.AI.Origins}
	if srv.cfg.HTTPClient != nil && len(srv.cfg.AI.Origins) > 0 {
		cfg.HTTP = srv.cfg.HTTPClient
	}
	return cfg
}

// runExam: "Prova" and "Reforço" of a note (src/stores/jobs.ts, createQuestions): the questions kept in the part `exam` (a Reforço
// after the ones there), their count in the meta, the activity in the index; the job gives back how many and what the web gave.
func (srv *Server) runExam(ctx context.Context, start JobStart, userID, fileID string, wrong []generate.Wrong, model, instruction string) error {
	_, _ = srv.db.Exec(`UPDATE jobs SET device_id = ? WHERE id = ?`, serverDevice, start.ID)
	row, err := findRow(srv.db, userID, fileID)
	if err != nil || row == nil || row.RemovedAt != nil {
		result, _ := json.Marshal(map[string]any{"count": 0, "web": generate.WebOutcome{}})
		srv.jobEnds(start.ID, userID, `state = 'done', result = ?, fraction = 1, stage = ?, last_progress = ?, stalled_since = NULL`, string(result), "Pronto.", "Pronto.")
		return nil
	}
	kind := "Prova"
	if len(wrong) > 0 {
		kind = "Reforço"
	}
	activity := srv.startActivity(ctx, userID, map[string]any{"kind": "exam", "label": kind + ": " + row.Name, "origin": row.Name, "destination": "questões do próprio arquivo", "fileId": fileID})
	fail := func(reason string) error {
		srv.finishActivity(context.WithoutCancel(ctx), userID, activity, "error", reason)
		return srv.jobFailed(start, userID, reason)
	}
	srv.jobSays(start.ID, userID, "Preparando as questões", nil)
	spent := &jobSpending{}
	chat := srv.chatPicked(model, "prova", "estudo", spent.add)
	if chat == nil {
		return fail("Nenhum modelo de IA do servidor faz a prova: escolha um em Configurações › Inteligência artificial.")
	}
	search, cannot := srv.webSearchFor(spent.add)
	fileType := "class"
	if row.NoteType != nil && *row.NoteType != "" {
		fileType = *row.NoteType
	}
	questions, web, err := generate.Questions(ctx, chat, srv.readPart(ctx, userID, row, "text"), row.Name, fileType, wrong, search, cannot, instruction)
	if err != nil {
		if ctx.Err() != nil {
			srv.finishActivity(context.WithoutCancel(ctx), userID, activity, "cancelled", "Cancelado por você.")
			return ctx.Err()
		}
		return fail(upper(err))
	}
	if len(questions) == 0 {
		return fail("A IA não devolveu nenhuma questão válida. Tente de novo.")
	}
	stored := make([]any, len(questions))
	for i, question := range questions {
		question["storedId"] = generate.NewID()
		stored[i] = question
	}
	var exam struct {
		Questions []any `json:"questions"`
		Attempts  []any `json:"attempts"`
	}
	_ = json.Unmarshal([]byte(srv.readPart(ctx, userID, row, "exam")), &exam)
	all := stored
	if len(wrong) > 0 {
		all = append(exam.Questions, stored...)
	}
	if exam.Attempts == nil {
		exam.Attempts = []any{}
	}
	body, _ := json.Marshal(map[string]any{"questions": all, "attempts": exam.Attempts})
	if _, err := srv.writePart(ctx, userID, fileID, "exam", body); err != nil {
		return fail("As questões não foram guardadas na nota: " + err.Error())
	}
	if err := srv.changeNote(userID, fileID, func(row *libraryRow, meta map[string]any) (string, bool) {
		meta["questionCount"] = len(all)
		return row.Name, true
	}); err != nil {
		return fail("As questões não foram contadas na nota: " + err.Error())
	}
	done := fmt.Sprintf("%d questões geradas. %s", len(questions), web.Note)
	srv.finishActivity(ctx, userID, activity, "done", done)
	result, _ := json.Marshal(map[string]any{"count": len(questions), "web": web})
	srv.jobEnds(start.ID, userID, `state = 'done', result = ?, fraction = 1, stage = ?, last_progress = ?, stalled_since = NULL`, string(result), done, done)
	return nil
}
