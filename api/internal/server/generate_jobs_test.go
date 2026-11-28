package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
)

// T207 (FR-084): the generations asked in the account run in Go, without the Chromium.

// fakeWriter is the AI of the generations: it answers each instruction with what `answers` says for a piece of it.
func fakeWriter(t *testing.T, answers map[string]string) (*httptest.Server, *sync.Map) {
	seen := &sync.Map{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Messages []struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"messages"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		system, user := "", ""
		for _, m := range body.Messages {
			if m.Role == "system" {
				system = m.Content
			} else {
				user = m.Content
			}
		}
		for piece, answer := range answers {
			if strings.Contains(system, piece) {
				seen.Store(piece, user)
				_ = json.NewEncoder(w).Encode(map[string]any{"choices": []map[string]any{{"message": map[string]any{"content": answer}}}, "usage": map[string]any{"cost": 0.0001}})
				return
			}
		}
		http.Error(w, "instrução desconhecida", http.StatusBadRequest)
	}))
	t.Cleanup(server.Close)
	return server, seen
}

func writerAccount(t *testing.T, h *harness, answers map[string]string) (*http.Client, string, *sync.Map, *bool) {
	t.Helper()
	ai, seen := fakeWriter(t, answers)
	h.srv.cfg.AI = AIConfig{Keys: map[string]string{"openrouter": "or"}, Origins: map[string]string{"openrouter": ai.URL}}
	chromium := false
	h.srv.cfg.JobRunner = func(ctx context.Context, start JobStart) error { chromium = true; <-ctx.Done(); return nil }
	uses := `{"providers":[{"id":"or","type":"openrouter"}],"models":[{"uid":"or::texto","pid":"or","mid":"texto"}],"defaults":{"estudo":"or::texto"}}`
	if _, err := h.db.Exec(`INSERT OR REPLACE INTO app_settings (key, value) VALUES ('ai_uses', ?)`, uses); err != nil {
		t.Fatal(err)
	}
	client, id := h.account("enabled", true, "ana@exemplo.com")
	return client, id, seen, &chromium
}

func noteIn(t *testing.T, h *harness, userID, id, name, meta, text string) {
	t.Helper()
	if _, err := h.db.Exec(`INSERT INTO library_items (user_id, id, item_kind, note_type, name, place, position, meta, created_at, updated_at, rev, seq) VALUES (?, ?, 'file', 'class', ?, 'app', 0, ?, '2026-11-28T10:00:00Z', '2026-11-28T10:00:00Z', 1, 1)`, userID, id, name, meta); err != nil {
		t.Fatal(err)
	}
	if text != "" {
		if _, err := h.srv.writePart(context.Background(), userID, id, "text", []byte(text)); err != nil {
			t.Fatal(err)
		}
	}
}

func TestTheTagsOfANoteAreSuggestedInGo(t *testing.T) {
	h := newHarness(t)
	ana, anaID, seen, chromium := writerAccount(t, h, map[string]string{"Você sugere etiquetas": `{"etiquetas": ["limites", "Cálculo 1", "derivadas"]}`})
	noteIn(t, h, anaID, "n1", "Aula de limites", `{"id":"n1","name":"Aula de limites","tags":["limites"]}`, "Limites laterais e continuidade.")
	noteIn(t, h, anaID, "n2", "Outra", `{"id":"n2","name":"Outra","tags":["provas","limites"]}`, "")
	_, body := h.do(ana, call{method: http.MethodPost, path: "/v1/jobs", body: map[string]any{"call": "suggestTags", "args": []any{"n1"}, "fileId": "n1", "title": "Etiquetas"}})
	job := waitJob(t, h, ana, body["id"].(string))
	if job["state"] != "done" || *chromium {
		t.Fatalf("job %v, chromium %v", job, *chromium)
	}
	asked, _ := seen.Load("Você sugere etiquetas")
	if asked != "Etiquetas que a pessoa já usa: limites, provas\n\nLimites laterais e continuidade." {
		t.Fatalf("asked %q", asked)
	}
	row, _ := findRow(h.db, anaID, "n1")
	var meta map[string]any
	_ = json.Unmarshal(row.Meta, &meta)
	if !reflect.DeepEqual(stringsOf(meta["suggestedTags"]), []string{"cálculo-1", "derivadas"}) {
		t.Fatalf("meta %v", meta)
	}
}

func TestTheMapAndTheCardsOfANoteAreMadeInGo(t *testing.T) {
	h := newHarness(t)
	ana, anaID, seen, chromium := writerAccount(t, h, map[string]string{
		"Você faz o mapa de uma nota":                  `{"nome": "Limites", "forma": "arvore", "raiz": {"texto": "Limites", "filhos": [{"texto": "Laterais", "filhos": []}]}}`,
		"Você faz cartões de memorização (flashcards)": `{"cartoes": [{"frente": "O que é limite?", "verso": "O valor de que f se aproxima."}]}`,
		"Você dá nome a um material":                   `{"nome": "Limites de funções"}`,
	})
	noteIn(t, h, anaID, "n1", "Aula de limites", `{"id":"n1","name":"Aula de limites"}`, "Limites laterais.")
	run := func(args map[string]any) map[string]any {
		_, body := h.do(ana, call{method: http.MethodPost, path: "/v1/jobs", body: map[string]any{"call": "generateArtifact", "args": []any{args}, "fileId": "n1", "title": "Mapa"}})
		job := waitJob(t, h, ana, body["id"].(string))
		if job["state"] != "done" || *chromium {
			t.Fatalf("job %v, chromium %v", job, *chromium)
		}
		result, _ := job["result"].(map[string]any)
		return result
	}
	mapa := run(map[string]any{"fileId": "n1", "artifact": "mapa", "instruction": "foco nos laterais"})
	if mapa["kind"] != "mapa" || mapa["name"] != "Limites" || mapa["diagram"] == nil {
		t.Fatalf("map %v", mapa)
	}
	if asked, _ := seen.Load("Você faz o mapa de uma nota"); !strings.HasSuffix(asked.(string), "foco nos laterais") {
		t.Fatalf("asked %q", asked)
	}
	deck := run(map[string]any{"fileId": "n1", "artifact": "cartoes"})
	cards, _ := deck["cards"].([]any)
	if deck["name"] != "Limites de funções" || len(cards) != 1 {
		t.Fatalf("deck %v", deck)
	}
	// "Substituir este": the same id and name
	again := run(map[string]any{"fileId": "n1", "artifact": "mapa", "again": mapa["id"], "replace": true})
	if again["id"] != mapa["id"] {
		t.Fatalf("replaced %v", again)
	}
	row, _ := findRow(h.db, anaID, "n1")
	var meta map[string]any
	_ = json.Unmarshal(row.Meta, &meta)
	list, _ := meta["artifacts"].([]any)
	due := stringsOf(meta["cardDue"])
	if len(list) != 2 || meta["hasMindmap"] != true || len(due) != 1 || row.Parts["artifacts/"+mapa["id"].(string)] == "" || row.Parts["artifacts/"+deck["id"].(string)] == "" {
		t.Fatalf("meta %v parts %v", meta, row.Parts)
	}
}

func TestTheProvaOfANoteIsMadeInGoAndKeptAsTheAppKeepsIt(t *testing.T) {
	h := newHarness(t)
	question := `{"tipo": "certo_errado", "enunciado": "Limite lateral existe sempre?", "certo": false, "explicacao": "Nem sempre."}`
	ana, anaID, seen, chromium := writerAccount(t, h, map[string]string{
		"Você prepara material para geração de provas": "Material preparado.",
		"Você confere questões de prova":               `{"vereditos": [{"id": 1, "veredito": "mantem"}]}`,
		"Você é gerador de provas":                     `{"questions": [` + question + `]}`,
	})
	_ = seen
	noteIn(t, h, anaID, "n1", "Aula de limites", `{"id":"n1","name":"Aula de limites"}`, "# Limites\n\nLimites laterais.")
	// the index the app made, with an activity of before
	if res, out := h.raw(ana, http.MethodPut, "/v1/library/index", []byte(`{"activities":[{"id":"a0"}],"settings":{}}`), map[string]string{"If-None-Match": "*", "Content-Type": "application/json"}); res.StatusCode != http.StatusOK {
		t.Fatalf("index %d %s", res.StatusCode, out)
	}
	_, body := h.do(ana, call{method: http.MethodPost, path: "/v1/jobs", body: map[string]any{"call": "createQuestions", "args": []any{"n1", nil, nil, ""}, "fileId": "n1", "title": "Prova"}})
	job := waitJob(t, h, ana, body["id"].(string))
	if job["state"] != "done" || *chromium {
		t.Fatalf("job %v, chromium %v", job, *chromium)
	}
	result, _ := job["result"].(map[string]any)
	if result["count"] != float64(1) {
		t.Fatalf("result %v", result)
	}
	row, _ := findRow(h.db, anaID, "n1")
	var exam struct {
		Questions []map[string]any `json:"questions"`
		Attempts  []any            `json:"attempts"`
	}
	_ = json.Unmarshal([]byte(h.srv.readPart(context.Background(), anaID, row, "exam")), &exam)
	var meta map[string]any
	_ = json.Unmarshal(row.Meta, &meta)
	if len(exam.Questions) != 1 || exam.Questions[0]["storedId"] == nil || exam.Attempts == nil || meta["questionCount"] != float64(1) {
		t.Fatalf("exam %+v meta %v", exam, meta)
	}
	_, raw := h.raw(ana, http.MethodGet, "/v1/library/index", nil, nil)
	var index map[string]any
	_ = json.Unmarshal(raw, &index)
	activities, _ := index["activities"].([]any)
	first, _ := activities[0].(map[string]any)
	if len(activities) != 2 || first["status"] != "done" || first["label"] != "Prova: Aula de limites" || index["settings"] == nil {
		t.Fatalf("index %v", index)
	}
}

func TestALessonAndAnAtaAreWrittenInGoAndKeptAsTheAppKeepsThem(t *testing.T) {
	h := newHarness(t)
	ana, anaID, seen, chromium := writerAccount(t, h, map[string]string{
		"Você é o Agente Aula":      `{"markdown": {"elements": [{"type": "heading", "text": "Limites", "level": 1}, {"type": "paragraph", "text": "Limite lateral."}]}}`,
		"Você escreve a ata de uma": `{"assunto": "Orçamento", "temas": [{"tema": "Custos", "pontos": [{"texto": "Corte de 10%", "hora": "00:05", "citacao": "corte de dez"}]}], "passos": []}`,
		"Você sugere etiquetas":     `{"etiquetas": ["limites"]}`,
	})
	noteIn(t, h, anaID, "n1", "Aula de limites", `{"id":"n1","name":"Aula de limites","status":"pending"}`, "")
	if _, err := h.srv.writePart(context.Background(), anaID, "n1", "source", []byte(`{"sourceExcerpt":null,"pendingExcerpt":"Material: limites laterais.","sourceText":null}`)); err != nil {
		t.Fatal(err)
	}
	run := func(name string, args []any) map[string]any {
		_, body := h.do(ana, call{method: http.MethodPost, path: "/v1/jobs", body: map[string]any{"call": name, "args": args, "fileId": args[0], "title": name}})
		job := waitJob(t, h, ana, body["id"].(string))
		if job["state"] != "done" || *chromium {
			t.Fatalf("%s: job %v, chromium %v", name, job, *chromium)
		}
		return job
	}
	run("generatePending", []any{"n1", nil, "foco nos laterais"})
	if asked, _ := seen.Load("Você é o Agente Aula"); !strings.HasPrefix(asked.(string), "Material: limites laterais.") || !strings.HasSuffix(asked.(string), "foco nos laterais") {
		t.Fatalf("asked %q", asked)
	}
	row, _ := findRow(h.db, anaID, "n1")
	var meta map[string]any
	_ = json.Unmarshal(row.Meta, &meta)
	made, _ := meta["made"].(map[string]any)
	if h.srv.readPart(context.Background(), anaID, row, "text") != "# Limites\n\nLimite lateral.\n" || meta["status"] != "ready" || meta["words"] != float64(4) || meta["generation"] == nil || made["instruction"] != "foco nos laterais" || !strings.Contains(h.srv.readPart(context.Background(), anaID, row, "source"), `"pendingExcerpt":null`) {
		t.Fatalf("meta %v", meta)
	}
	if !reflect.DeepEqual(stringsOf(meta["suggestedTags"]), []string{"limites"}) {
		t.Fatalf("tags %v", meta["suggestedTags"])
	}
	// "Gerar de novo": from its own text
	run("regenerate", []any{"n1"})
	if asked, _ := seen.Load("Você é o Agente Aula"); !strings.HasPrefix(asked.(string), "# Aula de limites\n\n# Limites") {
		t.Fatalf("again %q", asked)
	}
	// the Ata of a recording, in two passes, named by its subject and linked to the moments
	noteIn(t, h, anaID, "n2", "Reunião 28-11-2026", `{"id":"n2","name":"Reunião 28-11-2026","status":"pending"}`, "")
	if _, err := h.db.Exec(`UPDATE library_items SET note_type = 'meeting' WHERE id = 'n2'`); err != nil {
		t.Fatal(err)
	}
	transcript := `{"recording":{"blocks":[{"speaker":"speaker_0","start":5,"end":9,"text":"Vamos fazer um corte de dez por cento."}],"speakers":[{"id":"speaker_0","name":"Ana"}],"marks":[]},"transcript":"Ana [00:05]: Vamos fazer um corte de dez por cento."}`
	if _, err := h.srv.writePart(context.Background(), anaID, "n2", "transcript", []byte(transcript)); err != nil {
		t.Fatal(err)
	}
	if _, err := h.srv.writePart(context.Background(), anaID, "n2", "source", []byte(`{"sourceExcerpt":null,"pendingExcerpt":"Ana [00:05]: Vamos fazer um corte de dez por cento.","sourceText":null}`)); err != nil {
		t.Fatal(err)
	}
	run("generatePending", []any{"n2"})
	row, _ = findRow(h.db, anaID, "n2")
	text := h.srv.readPart(context.Background(), anaID, row, "text")
	if !strings.HasPrefix(text, "# Orçamento\n\n### Custos\n- Corte de 10% [▸ 00:0") || !strings.HasSuffix(row.Name, " - Orçamento") {
		t.Fatalf("%q %q", text, row.Name)
	}
	if asked, _ := seen.Load("Você escreve a ata de uma"); asked != "Ana [00:05]: Vamos fazer um corte de dez por cento.\n" {
		t.Fatalf("ata asked %q", asked)
	}
}

func TestTheSecondTabTheRedoneTranscriptAndTheRemainingLessonsRunInGo(t *testing.T) {
	h := newHarness(t)
	ana, anaID, seen, chromium := writerAccount(t, h, map[string]string{
		"Você é o Agente Aula":  `{"markdown": {"elements": [{"type": "paragraph", "text": "Aula escrita."}]}}`,
		"Você corrige a tra":    `{"correcoes": [{"fala": 1, "de": "orsamento", "para": "orçamento"}], "falantes": [{"fala": 1, "quem": "Bia"}]}`,
		"Você sugere etiquetas": `{"etiquetas": []}`,
	})
	noteIn(t, h, anaID, "r1", "Reunião 28-11-2026", `{"id":"r1","name":"Reunião 28-11-2026","type":"audio","origin":{"input":"recording","name":"Reunião 28-11-2026.webm"}}`, "Ana [00:01]: O orsamento.")
	if _, err := h.db.Exec(`UPDATE library_items SET note_type = 'audio' WHERE id = 'r1'`); err != nil {
		t.Fatal(err)
	}
	transcript := `{"recording":{"blocks":[{"speaker":"speaker_0","start":1,"end":3,"text":"O orsamento."}],"speakers":[{"id":"speaker_0","name":"Ana"}],"marks":[],"heard":{"screen":false}},"transcript":"Ana [00:01]: O orsamento."}`
	if _, err := h.srv.writePart(context.Background(), anaID, "r1", "transcript", []byte(transcript)); err != nil {
		t.Fatal(err)
	}
	run := func(name string, args []any) {
		_, body := h.do(ana, call{method: http.MethodPost, path: "/v1/jobs", body: map[string]any{"call": name, "args": args, "fileId": args[0], "title": name}})
		if job := waitJob(t, h, ana, body["id"].(string)); job["state"] != "done" || *chromium {
			t.Fatalf("%s: job %v, chromium %v", name, job, *chromium)
		}
	}
	run("redoTranscript", []any{"r1", "orçamento com ç; quem fala é a Bia", nil})
	row, _ := findRow(h.db, anaID, "r1")
	part := h.srv.readPart(context.Background(), anaID, row, "transcript")
	if !strings.Contains(part, `"text":"O orçamento."`) || !strings.Contains(part, `"original":"O orsamento."`) || !strings.Contains(part, `"name":"Bia"`) || !strings.Contains(part, `"heard":{"screen":false}`) {
		t.Fatalf("%s", part)
	}
	if text := h.srv.readPart(context.Background(), anaID, row, "text"); text != "Bia [00:01]: O orçamento." {
		t.Fatalf("text %q", text)
	}
	// the recording becomes an Aula
	run("generateSecondTab", []any{"r1", "lesson", nil, ""})
	row, _ = findRow(h.db, anaID, "r1")
	if asked, _ := seen.Load("Você é o Agente Aula"); !strings.HasPrefix(asked.(string), "# Conteúdo\n\nBia [00:01]: O orçamento.") || row.NoteType == nil || *row.NoteType != "class" {
		t.Fatalf("%q %v", asked, row.NoteType)
	}
	// a course with two lessons still to write
	for _, folder := range []struct{ id, parent string }{{"curso", ""}, {"modulo", "curso"}} {
		parent := any(nil)
		if folder.parent != "" {
			parent = folder.parent
		}
		if _, err := h.db.Exec(`INSERT INTO library_items (user_id, id, item_kind, name, folder_id, position, meta, created_at, updated_at, rev, seq) VALUES (?, ?, 'folder', ?, ?, 0, '{}', '2026-11-28T10:00:00Z', '2026-11-28T10:00:00Z', 1, 1)`, anaID, folder.id, "Pasta "+folder.id, parent); err != nil {
			t.Fatal(err)
		}
	}
	for _, id := range []string{"l1", "l2"} {
		noteIn(t, h, anaID, id, "Lição "+id, `{"id":"`+id+`","name":"Lição `+id+`","status":"pending","description":"cobre `+id+`"}`, "")
		if _, err := h.db.Exec(`UPDATE library_items SET folder_id = 'modulo' WHERE id = ?`, id); err != nil {
			t.Fatal(err)
		}
	}
	_, body := h.do(ana, call{method: http.MethodPost, path: "/v1/jobs", body: map[string]any{"call": "generateRemaining", "args": []any{"curso", nil, nil}, "title": "Aulas"}})
	if job := waitJob(t, h, ana, body["id"].(string)); job["state"] != "done" || *chromium {
		t.Fatalf("remaining: %v", job)
	}
	for _, id := range []string{"l1", "l2"} {
		row, _ := findRow(h.db, anaID, id)
		if h.srv.readPart(context.Background(), anaID, row, "text") != "Aula escrita.\n" {
			t.Fatalf("%s not written", id)
		}
	}
	if asked, _ := seen.Load("Você é o Agente Aula"); !strings.Contains(asked.(string), "## Onde esta aula se encaixa\nCurso: Pasta modulo") && !strings.Contains(asked.(string), "Curso: Pasta curso") {
		t.Fatalf("course %q", asked)
	}
}

func TestExplainAndGenerateFromASelectionMakeTheNoteInGoAndGiveItBackAtOnce(t *testing.T) {
	h := newHarness(t)
	ana, anaID, seen, chromium := writerAccount(t, h, map[string]string{
		"Você é o Agente Explicação": `{"markdown": {"elements": [{"type": "heading", "text": "Handshake em três vias", "level": 1}, {"type": "paragraph", "text": "SYN, SYN-ACK, ACK."}]}}`,
		"Você é o Agente Aula":       `{"markdown": {"elements": [{"type": "paragraph", "text": "Aula do trecho."}]}}`,
		"Você sugere etiquetas":      `{"etiquetas": []}`,
	})
	noteIn(t, h, anaID, "n1", "Redes", `{"id":"n1","name":"Redes"}`, "# Redes\n\nO handshake abre a conexão.")
	_, body := h.do(ana, call{method: http.MethodPost, path: "/v1/jobs", body: map[string]any{"call": "explainSelection", "args": []any{"n1", "O handshake abre a conexão.", "", "context", nil, nil}, "fileId": "n1", "title": "Explicação"}})
	job := waitJob(t, h, ana, body["id"].(string))
	id, _ := job["result"].(string)
	if job["state"] != "done" || *chromium || id == "" {
		t.Fatalf("job %v", job)
	}
	made, _ := findRow(h.db, anaID, id)
	source, _ := findRow(h.db, anaID, "n1")
	if made.Name != "Explicação: Handshake em três vias" || made.ParentFileID == nil || *made.ParentFileID != "n1" || made.FolderID == nil || source.FolderID == nil || *made.FolderID != *source.FolderID {
		t.Fatalf("made %+v source %+v", made, source)
	}
	if asked, _ := seen.Load("Você é o Agente Explicação"); !strings.HasPrefix(asked.(string), "Documento de origem: Redes\n\nContexto do documento:\n\n# Redes") {
		t.Fatalf("asked %q", asked)
	}
	if !strings.Contains(h.srv.readPart(context.Background(), anaID, made, "source"), `"sourceExcerpt":"O handshake abre a conexão."`) {
		t.Fatal("excerpt")
	}
	// "Gerar desta seleção": an Aula of the passage, in the same folder
	_, body = h.do(ana, call{method: http.MethodPost, path: "/v1/jobs", body: map[string]any{"call": "generateFromSelection", "args": []any{"n1", "O handshake abre a conexão.", "lesson", nil, nil, ""}, "fileId": "n1", "title": "Aula"}})
	job = waitJob(t, h, ana, body["id"].(string))
	id, _ = job["result"].(string)
	lesson, _ := findRow(h.db, anaID, id)
	if job["state"] != "done" || lesson == nil || lesson.Name != "Aula: O handshake abre a conexão." || h.srv.readPart(context.Background(), anaID, lesson, "text") != "Aula do trecho.\n" {
		t.Fatalf("job %v lesson %+v", job, lesson)
	}
	if asked, _ := seen.Load("Você é o Agente Aula"); asked != "# Conteúdo\n\nO handshake abre a conexão." {
		t.Fatalf("lesson asked %q", asked)
	}
}

func TestAnAtaFromATranscribedRecordingIsWrittenInGoInTheNotesFolder(t *testing.T) {
	h := newHarness(t)
	ana, anaID, seen, chromium := writerAccount(t, h, map[string]string{
		"Você escreve a ata de uma": `{"assunto": "Metas", "temas": [{"tema": "Vendas", "pontos": [{"texto": "Meta de 20%", "hora": "00:02", "citacao": "vinte por cento"}]}], "passos": []}`,
		"Você sugere etiquetas":     `{"etiquetas": []}`,
	})
	noteIn(t, h, anaID, "g1", "Reunião 28-11-2026", `{"id":"g1","name":"Reunião 28-11-2026","type":"audio","origin":{"input":"recording","name":"Reunião 28-11-2026.webm","mime":"audio/webm"}}`, "")
	transcript := `{"recording":{"blocks":[{"speaker":"speaker_0","start":2,"end":6,"text":"A meta é vinte por cento."}],"speakers":[{"id":"speaker_0","name":"Ana"}],"marks":[{"at":1,"kind":"note","text":"começo"}]},"transcript":null}`
	if _, err := h.srv.writePart(context.Background(), anaID, "g1", "transcript", []byte(transcript)); err != nil {
		t.Fatal(err)
	}
	_, body := h.do(ana, call{method: http.MethodPost, path: "/v1/jobs", body: map[string]any{"call": "generateFromNote", "args": []any{"g1", "meeting", nil, "home", ""}, "fileId": "g1", "title": "Ata"}})
	job := waitJob(t, h, ana, body["id"].(string))
	id, _ := job["result"].(string)
	if job["state"] != "done" || *chromium || id == "" {
		t.Fatalf("job %v chromium %v", job, *chromium)
	}
	ata, _ := findRow(h.db, anaID, id)
	source, _ := findRow(h.db, anaID, "g1")
	text := h.srv.readPart(context.Background(), anaID, ata, "text")
	if !strings.HasSuffix(ata.Name, " - Metas") || source.FolderID == nil || ata.FolderID == nil || *ata.FolderID != *source.FolderID || !strings.Contains(text, "- Meta de 20% [▸ 00:0") {
		t.Fatalf("ata %+v %q", ata, text)
	}
	if asked, _ := seen.Load("Você escreve a ata de uma"); asked != ">> ANOTAÇÃO [00:01]: começo\nAna [00:02]: A meta é vinte por cento.\n" {
		t.Fatalf("asked %q", asked)
	}
}
