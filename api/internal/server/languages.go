package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/regyeduardo/study-helper/api/internal/ai"
	"github.com/regyeduardo/study-helper/api/internal/langs"
	"github.com/regyeduardo/study-helper/api/internal/speech"
)

// Spec 004 (aprender idiomas): the languages mode, only with the structure on (contracts/api-idiomas.md). The domain is in
// internal/langs and internal/speech; here, only HTTP.

// languageErrors are the answers of each domain error.
var languageErrors = map[error]struct {
	status int
	code   string
}{
	langs.ErrLanguageExists:  {http.StatusConflict, "language_exists"},
	langs.ErrInvalidLanguage: {http.StatusUnprocessableEntity, "invalid_language"},
	langs.ErrNotFound:        {http.StatusNotFound, "not_found"},
	langs.ErrTitleRequired:   {http.StatusUnprocessableEntity, "title_required"},
	langs.ErrTextRequired:    {http.StatusUnprocessableEntity, "text_required"},
	langs.ErrTextTooLarge:    {http.StatusRequestEntityTooLarge, "text_too_large"},
	langs.ErrNotFailed:       {http.StatusConflict, "not_failed"},
	langs.ErrInvalidAnswer:   {http.StatusUnprocessableEntity, "invalid_answer"},
	speech.ErrInvalidText:    {http.StatusUnprocessableEntity, "invalid_text"},
	langs.ErrInvalidReason:   {http.StatusUnprocessableEntity, "invalid_reason"},
	ai.ErrProviderDown:       {http.StatusBadGateway, "provider_down"},
	ai.ErrNoKey:              {http.StatusServiceUnavailable, "ai_not_configured"},
}

func languageFail(w http.ResponseWriter, err error) {
	for known, answer := range languageErrors {
		if errors.Is(err, known) {
			data := map[string]any(nil)
			if known == langs.ErrTextTooLarge {
				data = map[string]any{"maxLength": langs.MaxTextChars}
			}
			fail(w, answer.status, answer.code, data)
			return
		}
	}
	fail(w, http.StatusInternalServerError, "internal_error", nil)
}

// languagesAI is the AI of the languages mode: the server's keys; the tests give fakes.
func (srv *Server) startLanguages() {
	client := &ai.Client{Keys: srv.cfg.AI.Keys, Bases: ai.BasesFrom(srv.cfg.AI.Origins), HTTP: &http.Client{Timeout: 7 * time.Minute}, MaxTokens: 16384}
	var writer langs.Chatter = client
	if srv.cfg.LanguagesAI != nil {
		writer = srv.cfg.LanguagesAI
	}
	var voice speech.Speaker = &ai.Client{Keys: srv.cfg.AI.Keys, Bases: ai.BasesFrom(srv.cfg.AI.Origins), HTTP: &http.Client{Timeout: time.Minute}}
	if srv.cfg.Voice != nil {
		voice = srv.cfg.Voice
	}
	first, _ := ai.ModelFor("idiomas-gerar", "")
	srv.generator = &langs.Generator{DB: srv.db, AI: writer, Models: append([]ai.Model{first}, ai.Ladder("idiomas-gerar")...), Now: srv.cfg.Now, Cache: &langs.ItemCache{Blobs: srv.cfg.Blobs}}
	srv.tts = &speech.TTS{AI: voice, Blobs: srv.cfg.Blobs, LeadIn: srv.cfg.LeadIn}
}

// ResumeLanguages puts back in the queue the texts left generating when the server stopped.
func (srv *Server) ResumeLanguages() {
	pending, err := langs.PendingTexts(srv.db)
	if err != nil {
		return
	}
	for _, row := range pending {
		srv.generator.Enqueue(row[0], row[2])
	}
}

// WaitLanguages is for the tests: every generation done.
func (srv *Server) WaitLanguages() { srv.generator.Wait() }

func (srv *Server) listLanguages(w http.ResponseWriter, _ *http.Request, s *Session) {
	list, err := langs.Languages(srv.db, s.User.ID, srv.cfg.Now())
	if err != nil {
		languageFail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"languages": list})
}

func (srv *Server) addLanguage(w http.ResponseWriter, r *http.Request, s *Session) {
	var body struct {
		Code   string `json:"code"`
		Name   string `json:"name"`
		Locale string `json:"locale"`
	}
	if !readJSON(r, &body) {
		fail(w, http.StatusBadRequest, "invalid_body", nil)
		return
	}
	language, err := langs.AddLanguage(srv.db, s.User.ID, body.Code, body.Name, body.Locale, srv.cfg.Now())
	if err != nil {
		languageFail(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, language)
}

func (srv *Server) getLanguage(w http.ResponseWriter, r *http.Request, s *Session) {
	detail, err := langs.LanguageDetail(srv.db, s.User.ID, r.PathValue("code"), srv.cfg.Now())
	if err != nil {
		languageFail(w, err)
		return
	}
	// constitution IV: a text generating says how far it is
	for i, text := range detail.Texts {
		if text.Status == "generating" {
			detail.Texts[i].Generation = srv.generator.ProgressOf(text.ID)
		}
	}
	writeJSON(w, http.StatusOK, detail)
}

func (srv *Server) addText(w http.ResponseWriter, r *http.Request, s *Session) {
	var body struct {
		Title string `json:"title"`
		Text  string `json:"text"`
		URL   string `json:"url"`
	}
	if !readJSON(r, &body) {
		fail(w, http.StatusBadRequest, "invalid_body", nil)
		return
	}
	if body.Text == "" && body.URL != "" {
		// reading a link comes in a next delivery; until then, only the text itself
		fail(w, http.StatusUnprocessableEntity, "link_unreadable", nil)
		return
	}
	id, err := langs.AddText(srv.db, s.User.ID, r.PathValue("code"), body.Title, body.Text, srv.cfg.Now())
	if err != nil {
		languageFail(w, err)
		return
	}
	srv.generator.Enqueue(s.User.ID, id)
	writeJSON(w, http.StatusAccepted, map[string]any{"id": id, "status": "generating"})
}

func (srv *Server) getText(w http.ResponseWriter, r *http.Request, s *Session) {
	text, status, err := langs.TextOut(srv.db, s.User.ID, r.PathValue("code"), r.PathValue("id"))
	if errors.Is(err, langs.ErrNotReady) {
		data := map[string]any{"status": status.Status}
		if status.Error != "" {
			data["reason"] = status.Error
		}
		fail(w, http.StatusConflict, "not_ready", data)
		return
	}
	if err != nil {
		languageFail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, text)
}

func (srv *Server) retryText(w http.ResponseWriter, r *http.Request, s *Session) {
	if err := langs.Retry(srv.db, s.User.ID, r.PathValue("code"), r.PathValue("id")); err != nil {
		languageFail(w, err)
		return
	}
	srv.generator.Enqueue(s.User.ID, r.PathValue("id"))
	writeJSON(w, http.StatusAccepted, map[string]any{"status": "generating"})
}

func (srv *Server) deleteText(w http.ResponseWriter, r *http.Request, s *Session) {
	if err := langs.DeleteText(srv.db, s.User.ID, r.PathValue("code"), r.PathValue("id")); err != nil {
		languageFail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (srv *Server) addAnswer(w http.ResponseWriter, r *http.Request, s *Session) {
	var answer langs.Answer
	if !readJSON(r, &answer) {
		fail(w, http.StatusBadRequest, "invalid_body", nil)
		return
	}
	if err := langs.RecordAnswer(srv.db, s.User.ID, r.PathValue("code"), answer, srv.cfg.Now()); err != nil {
		languageFail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (srv *Server) getKnowledge(w http.ResponseWriter, r *http.Request, s *Session) {
	knowledge, err := langs.Knowledge(srv.db, s.User.ID, r.PathValue("code"), srv.cfg.Now())
	if err != nil {
		languageFail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, knowledge)
}

func (srv *Server) getProgress(w http.ResponseWriter, r *http.Request, s *Session) {
	state, updated, err := langs.Progress(srv.db, s.User.ID, r.PathValue("code"), r.PathValue("id"))
	if err != nil {
		languageFail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"state": state, "updatedAt": updated})
}

func (srv *Server) putProgress(w http.ResponseWriter, r *http.Request, s *Session) {
	var body struct {
		State json.RawMessage `json:"state"`
	}
	if !readJSON(r, &body) {
		fail(w, http.StatusBadRequest, "invalid_body", nil)
		return
	}
	if err := langs.SaveProgress(srv.db, s.User.ID, r.PathValue("code"), r.PathValue("id"), body.State, srv.cfg.Now()); err != nil {
		languageFail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// reportCard: "Reportar" (wireframe C); the card is made again another way in the background.
func (srv *Server) reportCard(w http.ResponseWriter, r *http.Request, s *Session) {
	var body struct {
		Reason string `json:"reason"`
		Note   string `json:"note"`
	}
	if !readJSON(r, &body) || len(body.Note) > 1000 {
		fail(w, http.StatusBadRequest, "invalid_body", nil)
		return
	}
	if err := srv.generator.Report(s.User.ID, r.PathValue("code"), r.PathValue("id"), r.PathValue("card"), body.Reason, body.Note); err != nil {
		languageFail(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"status": "remaking"})
}

// speak is the model voice saying a sentence (cached; the same for every account).
func (srv *Server) speak(w http.ResponseWriter, r *http.Request, s *Session) {
	var body struct {
		Text   string `json:"text"`
		Locale string `json:"locale"`
		Voice  string `json:"voice"`
	}
	if !readJSON(r, &body) {
		fail(w, http.StatusBadRequest, "invalid_body", nil)
		return
	}
	if body.Locale == "" {
		body.Locale = "en-US"
	}
	audio, err := srv.tts.Say(r.Context(), body.Text, body.Locale, body.Voice)
	if err != nil {
		languageFail(w, err)
		return
	}
	w.Header().Set("Content-Type", "audio/mpeg")
	w.Header().Set("Content-Length", strconv.Itoa(len(audio)))
	w.Header().Set("Cache-Control", "private, max-age=86400")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(audio)
}
