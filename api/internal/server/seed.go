package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"time"
)

// Seed fills a test account with the test library of the measures (spec 007, research R1): folders, a big folder of text notes,
// recordings with a transcript of 1 hour and four voices, and short media in the App. It writes through the same routes the app uses
// (handler in-process, with a session of the test account), so the notes open in the app exactly as real ones. It only ever touches an
// account whose e-mail is of the reserved .local domain: never the owner's library.

// testEmail: the domain is "local" or ends in ".local", a name reserved for local networks that no real e-mail has.
func testEmail(email string) bool {
	at := strings.LastIndex(email, "@")
	if at <= 0 {
		return false
	}
	domain := email[at+1:]
	return domain == "local" || strings.HasSuffix(domain, ".local")
}

// SeedOptions is what to seed.
type SeedOptions struct {
	Email    string
	Password string
	// Folders counts every folder; the first holds the text notes, the second the recordings, the third the media, and the rest go one
	// inside the other (a deep path).
	Folders           int
	Notes             int
	Transcripts       int
	TranscriptMinutes int
	Media             int
	// MediaContent is the content of each short media (a playable file when given); random bytes otherwise.
	MediaContent []byte
	MediaMime    string
	// LongMedia, when given, is attached to the first recording (a playable media of about 1 hour).
	LongMedia     []byte
	LongMediaMime string
	// Fill adds fake media rows (no stored object) until the account uses this many bytes of media: the space screens near 10 GB.
	Fill int64
	// Redo deletes the test account first, when it is already there.
	Redo bool
}

// SeedReport is what was seeded.
type SeedReport struct {
	UserID      string `json:"userId"`
	BigFolderID string `json:"bigFolderId"`
	Folders     int    `json:"folders"`
	Notes       int    `json:"notes"`
	Transcripts int    `json:"transcripts"`
	Media       int    `json:"media"`
	FilledBytes int64  `json:"filledBytes"`
}

const seedDevice = "semeador"

var seedSpeakers = []string{"Ana", "Bruno", "Carla", "Diego"}

// seedClient calls the routes in-process as the test account.
type seedClient struct {
	handler http.Handler
	token   string
	origin  string
}

func (c *seedClient) send(method, path string, body []byte, headers map[string]string) (int, []byte) {
	request := httptest.NewRequest(method, path, bytes.NewReader(body))
	request.AddCookie(&http.Cookie{Name: sessionCookie, Value: c.token})
	request.Header.Set("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0 Safari/537.36")
	if method != http.MethodGet {
		request.Header.Set("X-Estudo", "1")
		request.Header.Set("Origin", c.origin)
		if headers["Content-Type"] == "" {
			request.Header.Set("Content-Type", "application/json")
		}
	}
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	recorder := httptest.NewRecorder()
	c.handler.ServeHTTP(recorder, request)
	out, _ := io.ReadAll(recorder.Result().Body)
	return recorder.Code, out
}

func (c *seedClient) json(method, path string, body any) (map[string]any, error) {
	raw, _ := json.Marshal(body)
	code, out := c.send(method, path, raw, nil)
	var answer map[string]any
	_ = json.Unmarshal(out, &answer)
	if code >= 300 {
		return answer, fmt.Errorf("%s %s: %d %s", method, path, code, strings.TrimSpace(string(out)))
	}
	return answer, nil
}

func (c *seedClient) row(id string, fields map[string]any) error {
	_, err := c.json(http.MethodPut, "/v1/library/items/"+id, map[string]any{"baseRev": 0, "row": fields})
	return err
}

func (c *seedClient) part(id, part, content string) error {
	code, out := c.send(http.MethodPut, "/v1/library/items/"+id+"/parts/"+part, []byte(content), map[string]string{"If-None-Match": "*", "Content-Type": "text/plain; charset=utf-8"})
	if code >= 300 {
		return fmt.Errorf("part %s/%s: %d %s", id, part, code, strings.TrimSpace(string(out)))
	}
	return nil
}

// media sends a media through the upload in parts of today, as the app does.
func (c *seedClient) media(item, media, name, mime string, content []byte) error {
	started, err := c.json(http.MethodPost, "/v1/uploads", map[string]any{"item": item, "media": media, "name": name, "mime": mime, "bytes": len(content)})
	if err != nil {
		return err
	}
	upload, _ := started["upload"].(string)
	size := int(asInt64(started["partSize"]))
	if size <= 0 {
		size = 10 << 20
	}
	for n, start := 1, 0; start < len(content); n, start = n+1, start+size {
		end := min(start+size, len(content))
		code, out := c.send(http.MethodPut, fmt.Sprintf("/v1/uploads/%s/parts/%d", upload, n), content[start:end], map[string]string{"Content-Type": "application/octet-stream"})
		if code >= 300 {
			return fmt.Errorf("upload part %d: %d %s", n, code, out)
		}
	}
	_, err = c.json(http.MethodPost, "/v1/uploads/"+upload+"/complete", map[string]any{})
	return err
}

func asInt64(value any) int64 {
	if number, ok := value.(float64); ok {
		return int64(number)
	}
	return 0
}

// Seed fills the test account; see SeedOptions.
func (srv *Server) Seed(ctx context.Context, options SeedOptions) (SeedReport, error) {
	email := strings.ToLower(strings.TrimSpace(options.Email))
	if !testEmail(email) {
		return SeedReport{}, errors.New("o semeador só mexe em conta de teste, com e-mail de domínio .local (ex.: teste-perf@local, pessoa@teste.local)")
	}
	if options.Password == "" {
		return SeedReport{}, errors.New("falta a senha da conta de teste")
	}
	var existing string
	err := srv.db.QueryRowContext(ctx, `SELECT id FROM user WHERE email = ?`, email).Scan(&existing)
	if err == nil {
		if !options.Redo {
			return SeedReport{}, fmt.Errorf("a conta %s já foi semeada; use --refazer para apagá-la e semear de novo", email)
		}
		if _, err := srv.db.ExecContext(ctx, `DELETE FROM user WHERE id = ?`, existing); err != nil {
			return SeedReport{}, err
		}
	}
	now := srv.now()
	userID := newID()
	if _, err := srv.db.ExecContext(ctx, `INSERT INTO user (id, email, email_verified, password_hash, name, status, app_enabled, enabled_at, hierarchy_at, created_at, updated_at)
		VALUES (?, ?, 1, ?, 'Teste de desempenho', 'enabled', 1, ?, ?, ?, ?)`, userID, email, hashPassword(options.Password), stamp(now), ts(now), stamp(now), stamp(now)); err != nil {
		return SeedReport{}, err
	}
	token := randomToken(32)
	if _, err := srv.db.ExecContext(ctx, `INSERT INTO devices (id, user_id, session_hash, name, created_at, seen_at, expires_at) VALUES (?, ?, ?, 'Semeador', ?, ?, ?)`,
		newID(), userID, sha256Hex(token), stamp(now), stamp(now), stamp(now.Add(time.Hour))); err != nil {
		return SeedReport{}, err
	}
	client := &seedClient{handler: srv.Handler(), token: token, origin: srv.cfg.AppOrigin}
	report := SeedReport{UserID: userID}
	at := ts(now)
	stamped := map[string]any{"at": at, "deviceId": seedDevice, "deviceName": "Semeador"}

	// folders: the first three side by side, the rest one inside the other
	folderIDs := make([]string, options.Folders)
	names := []string{"Pasta grande", "Reuniões", "Mídias"}
	for i := range folderIDs {
		id := fmt.Sprintf("seed-folder-%03d", i+1)
		folderIDs[i] = id
		name := fmt.Sprintf("Pasta funda %d", i-2)
		var parent any
		if i < len(names) {
			name = names[i]
		} else if i > len(names) {
			parent = folderIDs[i-1]
		}
		meta := map[string]any{"id": id, "name": name, "parentId": parent, "position": i, "description": "", "isCourse": false, "courseOrigin": nil,
			"courseDescription": nil, "courseMaterial": nil, "created": stamped, "updated": stamped, "deletedAt": nil}
		if err := client.row(id, map[string]any{"itemKind": "folder", "noteType": nil, "name": name, "folderId": parent, "parentFileId": nil, "place": "app",
			"recording": false, "position": i, "meta": meta, "driveRef": nil, "createdAt": at, "updatedAt": at, "trashedAt": nil, "trashedWith": nil}); err != nil {
			return report, err
		}
		report.Folders++
	}
	folderAt := func(index int) any {
		if index < len(folderIDs) {
			return folderIDs[index]
		}
		return nil
	}
	if len(folderIDs) > 0 {
		report.BigFolderID = folderIDs[0]
	}

	note := func(id, name, noteType string, folder any, position int, origin map[string]any, words int, recording bool) error {
		meta := map[string]any{"id": id, "name": name, "folderId": folder, "type": noteType, "description": "", "status": "ready", "position": position,
			"favorite": false, "tags": []string{}, "parentFileId": nil, "sourceExcerpt": nil, "pendingExcerpt": nil, "origin": origin, "generation": nil,
			"created": stamped, "updated": stamped, "deletedAt": nil, "words": words, "readingMinutes": max(1, words/200), "mastery": nil,
			"lastReviewedAt": nil, "questionCount": 0}
		if origin == nil {
			meta["origin"] = nil
		} else if origin["storedFileId"] != nil {
			// the media kept in the App, as the app records it (src/lib/storage/app-repository.ts, putSource)
			meta["kept"] = "arquivo"
		}
		return client.row(id, map[string]any{"itemKind": "file", "noteType": noteType, "name": name, "folderId": folder, "parentFileId": nil, "place": "app",
			"recording": recording, "position": position, "meta": meta, "driveRef": nil, "createdAt": at, "updatedAt": at, "trashedAt": nil, "trashedWith": nil})
	}

	for i := 0; i < options.Notes; i++ {
		if err := ctx.Err(); err != nil {
			return report, err
		}
		id := fmt.Sprintf("seed-note-%04d", i+1)
		text := seedText(i)
		if err := note(id, fmt.Sprintf("Nota de estudo %04d", i+1), "explanation", folderAt(0), i, nil, len(strings.Fields(text)), false); err != nil {
			return report, err
		}
		if err := client.part(id, "text", text); err != nil {
			return report, err
		}
		report.Notes++
	}

	minutes := options.TranscriptMinutes
	if minutes <= 0 {
		minutes = 60
	}
	for i := 0; i < options.Transcripts; i++ {
		if err := ctx.Err(); err != nil {
			return report, err
		}
		id := fmt.Sprintf("seed-rec-%03d", i+1)
		origin := map[string]any{"input": "recording", "name": fmt.Sprintf("Reunião %03d.webm", i+1), "mime": "audio/webm", "durationSeconds": minutes * 60, "storage": "none"}
		if i == 0 && len(options.LongMedia) > 0 {
			origin["storage"], origin["storedFileId"], origin["sizeBytes"] = "drive", "app:"+id+"/seed-long", len(options.LongMedia)
		}
		transcript := seedTranscript(i, minutes)
		if err := note(id, fmt.Sprintf("Reunião de teste %03d", i+1), "audio", folderAt(1), i, origin, 150*minutes, true); err != nil {
			return report, err
		}
		if err := client.part(id, "transcript", transcript); err != nil {
			return report, err
		}
		if i == 0 && len(options.LongMedia) > 0 {
			mime := options.LongMediaMime
			if mime == "" {
				mime = "audio/webm"
			}
			if err := client.media(id, "seed-long", "Reunião longa.webm", mime, options.LongMedia); err != nil {
				return report, err
			}
		}
		report.Transcripts++
	}

	mediaContent, mediaMime := options.MediaContent, options.MediaMime
	if len(mediaContent) == 0 {
		mediaContent = make([]byte, 64<<10)
		_, _ = rand.Read(mediaContent)
		mediaMime = "audio/webm"
	}
	for i := 0; i < options.Media; i++ {
		id := fmt.Sprintf("seed-media-%03d", i+1)
		origin := map[string]any{"input": "file", "name": fmt.Sprintf("Áudio curto %03d.webm", i+1), "mime": mediaMime, "sizeBytes": len(mediaContent),
			"storage": "drive", "storedFileId": fmt.Sprintf("app:%s/seed-m%03d", id, i+1)}
		if err := note(id, fmt.Sprintf("Áudio curto %03d", i+1), "audio", folderAt(2), i, origin, 0, false); err != nil {
			return report, err
		}
		if err := client.media(id, fmt.Sprintf("seed-m%03d", i+1), fmt.Sprintf("Áudio curto %03d.webm", i+1), mediaMime, mediaContent); err != nil {
			return report, err
		}
		report.Media++
	}

	if options.Fill > 0 {
		filled, err := srv.seedFill(ctx, userID, options.Fill, now)
		if err != nil {
			return report, err
		}
		report.FilledBytes = filled
	}
	// the seeder's own session ends here: the measures sign in with the password, as a person would
	_, _ = srv.db.ExecContext(ctx, `DELETE FROM devices WHERE user_id = ? AND name = 'Semeador'`, userID)
	return report, nil
}

// seedFill adds fake media rows of up to 500 MB until the account uses `target` bytes of media; no object is stored for them.
func (srv *Server) seedFill(ctx context.Context, userID string, target int64, now time.Time) (int64, error) {
	tx, err := srv.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	var used int64
	if err := tx.QueryRow(`SELECT media_bytes FROM user WHERE id = ?`, userID).Scan(&used); err != nil {
		return 0, err
	}
	const chunk = int64(500_000_000)
	var added int64
	for n := 1; used+added < target; n++ {
		size := min(chunk, target-used-added)
		seq, err := nextSeq(tx, userID)
		if err != nil {
			return 0, err
		}
		id := fmt.Sprintf("seed-fill-%03d", n)
		name := fmt.Sprintf("Vídeo grande de teste %03d", n)
		media, _ := json.Marshal(mediaRef{ID: id, Key: "seed/fake/" + id, Mime: "video/webm", Bytes: size, Status: "complete"})
		meta, _ := json.Marshal(map[string]any{"id": id, "name": name, "type": "video", "folderId": nil, "semeado": true})
		if _, err := tx.Exec(`INSERT INTO library_items (user_id, id, item_kind, note_type, name, place, meta, parts, media, media_bytes, created_at, updated_at, seq)
			VALUES (?, ?, 'file', 'video', ?, 'app', ?, '{}', ?, ?, ?, ?, ?)`, userID, id, name, string(meta), string(media), size, ts(now), ts(now), seq); err != nil {
			return 0, err
		}
		added += size
	}
	if _, err := tx.Exec(`UPDATE user SET media_bytes = media_bytes + ? WHERE id = ?`, added, userID); err != nil {
		return 0, err
	}
	return used + added, tx.Commit()
}

var seedWords = strings.Fields(`a reunião começou com a revisão do que ficou pendente na semana passada e cada pessoa contou o andamento das tarefas
o time decidiu priorizar a entrega do relatório antes do fim do mês porque o cliente pediu os números para a apresentação
houve dúvida sobre o prazo do fornecedor e ficou combinado que alguém liga amanhã cedo para confirmar a data
a parte técnica mostrou que o sistema fica lento quando muitos usuários abrem a mesma tela ao mesmo tempo
a proposta é medir primeiro e só depois mudar o que realmente pesa com números antes e depois de cada mudança`)

// seedText is a note of about 600 words, different for each index.
func seedText(index int) string {
	var out strings.Builder
	fmt.Fprintf(&out, "# Nota de estudo %04d\n\n", index+1)
	for paragraph := 0; paragraph < 8; paragraph++ {
		fmt.Fprintf(&out, "## Parte %d\n\n", paragraph+1)
		for word := 0; word < 75; word++ {
			out.WriteString(seedWords[(index*7+paragraph*13+word)%len(seedWords)])
			out.WriteByte(' ')
		}
		out.WriteString("\n\n")
	}
	return out.String()
}

// seedTranscript is the transcript part of a recording: blocks of about 6 seconds through `minutes`, four voices taking turns.
func seedTranscript(index, minutes int) string {
	type block struct {
		Speaker string  `json:"speaker"`
		Start   float64 `json:"start"`
		End     float64 `json:"end"`
		Text    string  `json:"text"`
	}
	type speaker struct {
		ID        string `json:"id"`
		Name      string `json:"name"`
		Suggested bool   `json:"suggested"`
	}
	speakers := make([]speaker, len(seedSpeakers))
	for i, name := range seedSpeakers {
		speakers[i] = speaker{ID: fmt.Sprintf("s%d", i+1), Name: name, Suggested: false}
	}
	var blocks []block
	var plain strings.Builder
	for start, n := 0.0, 0; start < float64(minutes*60); start, n = start+6, n+1 {
		var text strings.Builder
		for word := 0; word < 16; word++ {
			text.WriteString(seedWords[(index*11+n*5+word)%len(seedWords)])
			if word < 15 {
				text.WriteByte(' ')
			}
		}
		who := seedSpeakers[(n/3)%len(seedSpeakers)]
		blocks = append(blocks, block{Speaker: who, Start: start, End: start + 6, Text: text.String()})
		fmt.Fprintf(&plain, "%s: %s\n", who, text.String())
	}
	out, _ := json.Marshal(map[string]any{
		"recording":  map[string]any{"blocks": blocks, "speakers": speakers, "marks": []any{}},
		"transcript": plain.String(),
	})
	return string(out)
}
