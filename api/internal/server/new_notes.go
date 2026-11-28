package server

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strings"

	"github.com/regyeduardo/study-helper/api/internal/generate"
	"github.com/regyeduardo/study-helper/api/internal/transcribe"
)

// T207: the notes and the folders a generation makes, as the app makes them (src/lib/defaults.ts, newFileMeta and newFolderMeta; the
// row as src/lib/storage/app-repository.ts writes it), and "Explicar" and "Gerar desta seleção" in Go.

var urlOnly = regexp.MustCompile(`(?i)^\S*?(https?://[^\s<>"]+?)[.,;:!?)\]'"»]*$`)

// linkIn is the address a selection is, when it is only one (note-source.ts, linkIn).
func linkIn(selected string) string {
	text := strings.TrimSpace(selected)
	found := urlOnly.FindStringSubmatch(text)
	if found == nil {
		return ""
	}
	before := text[:strings.Index(text, found[1])]
	if strings.Trim(before, `([«'"`) != "" {
		return ""
	}
	return found[1]
}

func selectionTitle(excerpt string) string {
	condensed := strings.Join(strings.Fields(excerpt), " ")
	if runes := []rune(condensed); len(runes) > 60 {
		return string(runes[:57]) + "..."
	}
	return condensed
}

func explanationName(markdown, excerpt string) string {
	for _, line := range strings.Split(markdown, "\n") {
		if stripped := strings.TrimSpace(line); strings.HasPrefix(stripped, "#") {
			if title := strings.TrimSpace(strings.TrimLeft(stripped, "#")); title != "" {
				return title
			}
		}
	}
	condensed := []rune(strings.Join(strings.Fields(excerpt), " "))
	if name := string(condensed[:min(len(condensed), 60)]); name != "" {
		return name
	}
	return "Explicação"
}

func sameName(a, b string) bool { return strings.EqualFold(strings.TrimSpace(a), strings.TrimSpace(b)) }

func optional(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

// newFolder is a folder of that name in that place: the one there already (the app's "reuse"), else a new one.
func (srv *Server) newFolder(userID, name string, parentID *string) (string, error) {
	for _, folder := range srv.libraryOf(userID).folders {
		same := (folder.FolderID == nil && parentID == nil) || (folder.FolderID != nil && parentID != nil && *folder.FolderID == *parentID)
		if same && live(folder) && sameName(folder.Name, name) {
			return folder.ID, nil
		}
	}
	id := generate.NewID()
	stamp := srv.stamp()
	meta := map[string]any{"id": id, "name": name, "parentId": optional(parentID), "position": 0, "description": "", "isCourse": false, "courseOrigin": nil, "courseDescription": nil, "courseMaterial": nil, "created": stamp, "updated": stamp, "deletedAt": nil}
	raw, _ := json.Marshal(meta)
	at, _ := stamp["at"].(string)
	return id, srv.insertRow(userID, id, rowFields{ItemKind: "folder", Name: name, FolderID: parentID, Place: "app", Meta: raw, CreatedAt: at, UpdatedAt: at})
}

func (srv *Server) insertRow(userID, id string, fields rowFields) error {
	tx, err := srv.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	seq, err := nextSeq(tx, userID)
	if err != nil {
		return err
	}
	if _, err := srv.applyRow(tx, userID, id, 0, fields, seq, true); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	srv.notifyMap(userID, seq)
	return nil
}

// moveNote puts a note in a folder.
func (srv *Server) moveNote(userID, fileID string, folderID *string) error {
	return srv.changeNoteNamed(userID, fileID, func(row *libraryRow, meta map[string]any) (string, bool) {
		row.FolderID = folderID
		meta["folderId"] = optional(folderID)
		meta["updated"] = srv.stamp()
		return row.Name, true
	})
}

// newNote makes a note with the app's defaults and these fields; a name the folder has becomes "Nome (2)". The excerpts go in the part
// `source`, as the app keeps them.
func (srv *Server) newNote(ctx context.Context, userID string, fields map[string]any, kept sourceOf) (string, error) {
	id := generate.NewID()
	stamp := srv.stamp()
	meta := map[string]any{"id": id, "folderId": nil, "description": "", "status": "ready", "position": 0, "favorite": false, "tags": []any{}, "parentFileId": nil, "sourceExcerpt": nil, "pendingExcerpt": nil,
		"origin": nil, "generation": nil, "created": stamp, "updated": stamp, "deletedAt": nil, "words": 0, "readingMinutes": 0, "mastery": nil, "lastReviewedAt": nil, "questionCount": 0}
	for key, value := range fields {
		meta[key] = value
	}
	meta["sourceExcerpt"], meta["pendingExcerpt"] = nil, nil
	name, _ := meta["name"].(string)
	kind, _ := meta["type"].(string)
	folderID, _ := meta["folderId"].(string)
	parentID, _ := meta["parentFileId"].(string)
	at, _ := stamp["at"].(string)
	var folder, parent *string
	if folderID != "" {
		folder = &folderID
	}
	if parentID != "" {
		parent = &parentID
	}
	for round := 0; round < 50; round++ {
		meta["name"] = name
		raw, _ := json.Marshal(meta)
		err := srv.insertRow(userID, id, rowFields{ItemKind: "file", NoteType: &kind, Name: name, FolderID: folder, ParentFileID: parent, Place: "app", Meta: raw, CreatedAt: at, UpdatedAt: at})
		var taken *rowError
		if errors.As(err, &taken) && taken.code == "name_taken" {
			name = nextName(name)
			continue
		}
		if err != nil {
			return "", err
		}
		if kept.SourceExcerpt != nil || kept.PendingExcerpt != nil || kept.SourceText != nil {
			body, _ := json.Marshal(kept)
			if _, err := srv.writePart(ctx, userID, id, "source", body); err != nil {
				return "", err
			}
		}
		return id, nil
	}
	return "", errors.New("nenhum nome livre na pasta")
}

// jobGives is the value a call gives back at once while its writing goes on (the new note: the device opens it now).
func (srv *Server) jobGives(id, userID string, result any) {
	raw, _ := json.Marshal(result)
	_, _ = srv.db.Exec(`UPDATE jobs SET result = ?, updated_at = ? WHERE id = ? AND state = 'running'`, string(raw), ts(srv.now()), id)
	srv.notifyJob(userID, id)
}

// homeFolder is the folder named after a note: the one it is in, one beside it with its name, or one made there (homeFolderOf); the
// note goes into it.
func (srv *Server) homeFolder(userID string, source *libraryRow) (*string, error) {
	lib := srv.libraryOf(userID)
	if source.FolderID != nil {
		if own, ok := lib.folders[*source.FolderID]; ok && live(own) && own.Name == source.Name {
			return source.FolderID, nil
		}
	}
	id, err := srv.newFolder(userID, source.Name, source.FolderID)
	if err != nil {
		return nil, err
	}
	if source.FolderID == nil || *source.FolderID != id {
		if err := srv.moveNote(userID, source.ID, &id); err != nil {
			return nil, err
		}
	}
	return &id, nil
}

// explainRequest is what "Explicar" asks (explainSelection).
type explainRequest struct {
	fileID, excerpt, prompt, mode, model string
	home                                 bool
	folderID, replace                    *string
}

func lineageOf(row *libraryRow, lib library) []string {
	byID := map[string]*libraryRow{}
	for _, file := range lib.files {
		byID[file.ID] = file
	}
	out := []string{}
	seen := map[string]bool{row.ID: true}
	for current := row.ParentFileID; current != nil && !seen[*current]; {
		seen[*current] = true
		parent, ok := byID[*current]
		if !ok {
			break
		}
		out = append(out, parent.Name)
		current = parent.ParentFileID
	}
	return out
}

// selectionInput is what the explanation of a selection is written from (course-lesson.ts, selectionInput).
func selectionInput(row *libraryRow, content string, lib library, excerpt, prompt, mode string) string {
	if mode == "concept" {
		instruction := strings.TrimSpace(prompt)
		if instruction == "" {
			instruction = "Explique o conceito por trás deste trecho, sem prender ao documento de origem."
		}
		return "Trecho selecionado:\n\n" + excerpt + "\n\nInstrução:\n\n" + instruction
	}
	if strings.TrimSpace(prompt) != "" {
		return "Trecho selecionado:\n\n" + excerpt + "\n\nInstrução:\n\n" + strings.TrimSpace(prompt)
	}
	origin := []string{"Documento de origem: " + row.Name}
	for _, step := range lineageOf(row, lib) {
		origin = append(origin, "Veio de: "+step)
	}
	runes := []rune(content)
	return strings.Join(origin, "\n") + "\n\nContexto do documento:\n\n" + string(runes[:min(len(runes), 1200)]) + "\n\nExplique o trecho abaixo, considerando de onde ele veio:\n\n" + excerpt
}

// runExplain: "Explicar" a selection (explainSelection): the new note (or the one it replaces) given back at once, then written.
func (srv *Server) runExplain(ctx context.Context, start JobStart, userID string, asked explainRequest) error {
	_, _ = srv.db.Exec(`UPDATE jobs SET device_id = ? WHERE id = ?`, serverDevice, start.ID)
	source, err := findRow(srv.db, userID, asked.fileID)
	if err != nil || source == nil || source.RemovedAt != nil {
		return srv.jobFailed(start, userID, "Arquivo de origem não encontrado.")
	}
	content := srv.readPart(ctx, userID, source, "text")
	made := srv.choiceOf("explicacao", asked.model, asked.prompt)
	var folderID *string
	switch {
	case asked.folderID != nil:
		folderID = asked.folderID
	case asked.home:
		if folderID, err = srv.homeFolder(userID, source); err != nil {
			return srv.jobFailed(start, userID, "A pasta da nota não foi feita: "+err.Error())
		}
	case asked.mode == "context":
		folderID = source.FolderID
		if folderID == nil {
			id, err := srv.newFolder(userID, source.Name, nil)
			if err == nil {
				err = srv.moveNote(userID, source.ID, &id)
			}
			if err != nil {
				return srv.jobFailed(start, userID, "A pasta da nota não foi feita: "+err.Error())
			}
			folderID = &id
		}
	}
	noteID := ""
	if asked.replace != nil {
		if replaced, err := findRow(srv.db, userID, *asked.replace); err == nil && replaced != nil && replaced.RemovedAt == nil {
			noteID = replaced.ID
		}
	}
	if noteID == "" {
		excerpt := asked.excerpt
		noteID, err = srv.newNote(ctx, userID, map[string]any{"name": "Explicação: " + selectionTitle(asked.excerpt), "type": "explanation", "description": source.Name, "folderId": optional(folderID), "parentFileId": source.ID,
			"status": "generating", "origin": map[string]any{"input": "text", "name": `trecho de "` + source.Name + `"`, "storage": "none"}, "made": made}, sourceOf{SourceExcerpt: &excerpt})
		if err != nil {
			return srv.jobFailed(start, userID, "A explicação não foi criada: "+err.Error())
		}
	}
	srv.jobGives(start.ID, userID, noteID)
	plan := writing{agent: "explanation", content: selectionInput(source, content, srv.libraryOf(userID), asked.excerpt, asked.prompt, asked.mode), label: "Explicação", origin: `trecho de "` + source.Name + `"`, pick: asked.model, keepName: true, made: made, inside: true}
	if err := srv.writeNote(ctx, start, userID, noteID, plan); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return srv.jobFailed(start, userID, err.Error())
	}
	if asked.replace == nil {
		if row, err := findRow(srv.db, userID, noteID); err == nil && row != nil {
			if saved := srv.readPart(ctx, userID, row, "text"); saved != "" {
				_ = srv.changeNoteNamed(userID, noteID, func(row *libraryRow, meta map[string]any) (string, bool) {
					return "Explicação: " + explanationName(saved, asked.excerpt), true
				})
			}
		}
	}
	srv.jobEnds(start.ID, userID, `state = 'done', fraction = 1, stage = ?, last_progress = ?, stalled_since = NULL`, "Pronta e salva na Biblioteca.", "Pronta e salva na Biblioteca.")
	return nil
}

// runFromSelection: "Gerar desta seleção" of a passage (generateFromSelection, not a link): the new note given back at once, then
// written from the passage as it is.
func (srv *Server) runFromSelection(ctx context.Context, start JobStart, userID, fileID, excerpt, agent, model string, placed bool, folderID *string, instruction string) error {
	_, _ = srv.db.Exec(`UPDATE jobs SET device_id = ? WHERE id = ?`, serverDevice, start.ID)
	note, err := findRow(srv.db, userID, fileID)
	if err != nil || note == nil || note.RemovedAt != nil {
		srv.jobEnds(start.ID, userID, `state = 'done', result = 'null', fraction = 1, stage = ?, last_progress = ?, stalled_since = NULL`, "Pronto.", "Pronto.")
		return nil
	}
	if !placed {
		folderID = note.FolderID
	}
	passage := `trecho de "` + note.Name + `"`
	text := strings.TrimSpace(excerpt)
	title := selectionTitle(excerpt)
	content := "# Conteúdo\n\n" + text
	label := agentLabel[agent]
	at := isoNow(srv.now())
	noteID, err := srv.newNote(ctx, userID, map[string]any{"name": label + ": " + title, "type": fileTypeOf[agent], "description": "gerado de " + note.Name, "folderId": optional(folderID), "parentFileId": note.ID, "status": "generating",
		"origin": map[string]any{"input": "text", "name": passage, "sizeBytes": len(text), "mime": "text/plain", "storage": "none"}, "source": map[string]any{"kind": "text", "title": title, "at": at},
		"made": srv.choiceOf(agentUse[agent], model, instruction)}, sourceOf{PendingExcerpt: &content, SourceText: &text})
	if err != nil {
		return srv.jobFailed(start, userID, "A nota não foi criada: "+err.Error())
	}
	srv.jobGives(start.ID, userID, noteID)
	return srv.writeNote(ctx, start, userID, noteID, writing{agent: agent, content: content, label: label, origin: passage, pick: model, instruction: instruction})
}

// mediaOf is the media of a note by its origin (file-types.ts, mediaOf): "video", "audio" or "text".
func mediaOf(meta map[string]any) string {
	origin, _ := meta["origin"].(map[string]any)
	input, _ := origin["input"].(string)
	if input != "recording" && input != "file" {
		return "text"
	}
	mime, _ := origin["mime"].(string)
	switch {
	case strings.HasPrefix(mime, "video/"):
		return "video"
	case strings.HasPrefix(mime, "audio/") || input == "recording":
		return "audio"
	}
	return "text"
}

// fromNotePlan is "Gerar desta nota" (generateFromNote) when its material is text already: a note of text, or a recording already
// transcribed that is not to be watched; nil when the app has to do it (the media to the AI, the screen, a link, a transcription first).
func (srv *Server) fromNotePlan(ctx context.Context, userID string, args []json.RawMessage) func(ctx context.Context, start JobStart) error {
	text := func(index int) string {
		var out string
		if index < len(args) {
			_ = json.Unmarshal(args[index], &out)
		}
		return out
	}
	fileID, agent, model, instruction, analyze := text(0), text(1), text(2), text(4), text(5)
	if agentLabel[agent] == "" {
		return nil
	}
	source, err := findRow(srv.db, userID, fileID)
	if err != nil || source == nil || source.RemovedAt != nil {
		return nil
	}
	var meta map[string]any
	_ = json.Unmarshal(source.Meta, &meta)
	origin, _ := meta["origin"].(map[string]any)
	if origin["input"] == "youtube" {
		return nil
	}
	kind := mediaOf(meta)
	asked := ""
	switch kind {
	case "audio":
		asked = "transcricao"
	case "video":
		asked = analyze
	}
	// the media itself to the AI, or the screen of the video read step by step: still the app's
	inHand := kind != "text" && source.Media != nil && source.Media.Status == "stored"
	if asked == "quadros" || !(asked == "transcricao" || (asked == "" && !inHand)) {
		return nil
	}
	var transcript struct {
		Recording  *transcribe.Recording `json:"recording"`
		Transcript *string               `json:"transcript"`
	}
	_ = json.Unmarshal([]byte(srv.readPart(ctx, userID, source, "transcript")), &transcript)
	var recording *transcribe.Recording
	held := ""
	if transcript.Recording != nil && len(transcript.Recording.Blocks) > 0 {
		recording = transcript.Recording
		held = transcribe.TranscriptText(recording.Blocks, recording.Speakers)
	} else if content := srv.readPart(ctx, userID, source, "text"); content != "" {
		held = content
	} else if transcript.Transcript != nil {
		held = *transcript.Transcript
	}
	// nothing written yet: a transcription to make first, or a source to read
	if strings.TrimSpace(held) == "" {
		return nil
	}
	material := "# Conteúdo\n\n" + held
	var place struct {
		FolderID *string `json:"folderId"`
		Replace  *string `json:"replace"`
	}
	home := len(args) < 4 || string(args[3]) == "null" || string(args[3]) == `"home"`
	if !home {
		_ = json.Unmarshal(args[3], &place)
	}
	made := srv.choiceOf(agentUse[agent], model, instruction)
	if kind == "video" && analyze != "" {
		made["analyze"] = analyze
	}
	return func(ctx context.Context, start JobStart) error {
		_, _ = srv.db.Exec(`UPDATE jobs SET device_id = ? WHERE id = ?`, serverDevice, start.ID)
		plan := writing{agent: agent, content: material, label: agentLabel[agent], origin: source.Name, pick: model, instruction: instruction, recording: recording, made: made}
		if place.Replace != nil {
			replaced, err := findRow(srv.db, userID, *place.Replace)
			if err != nil || replaced == nil || replaced.RemovedAt != nil {
				srv.jobEnds(start.ID, userID, `state = 'done', result = 'null', fraction = 1, stage = ?, last_progress = ?, stalled_since = NULL`, "Pronto.", "Pronto.")
				return nil
			}
			srv.jobGives(start.ID, userID, replaced.ID)
			plan.keepName = true
			return srv.writeNote(ctx, start, userID, replaced.ID, plan)
		}
		folderID := place.FolderID
		if home {
			var err error
			if folderID, err = srv.homeFolder(userID, source); err != nil {
				return srv.jobFailed(start, userID, "A pasta da nota não foi feita: "+err.Error())
			}
		}
		noteID, err := srv.newNote(ctx, userID, map[string]any{"name": agentLabel[agent] + ": " + source.Name, "type": fileTypeOf[agent], "description": "gerado de " + source.Name, "folderId": optional(folderID), "parentFileId": source.ID,
			"status": "generating", "origin": map[string]any{"input": "text", "name": source.Name, "storage": "none"}, "made": made}, sourceOf{PendingExcerpt: &material})
		if err != nil {
			return srv.jobFailed(start, userID, "A nota não foi criada: "+err.Error())
		}
		srv.jobGives(start.ID, userID, noteID)
		return srv.writeNote(ctx, start, userID, noteID, plan)
	}
}
