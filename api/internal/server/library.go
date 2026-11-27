package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/regyeduardo/study-helper/api/internal/blobs"
)

// Entrega 4 (spec 003, história 2): the map of the library, the parts of each note in versions that never change, and the index.
// Model approved on 2026-11-21 (data-model.md, "Entrega 4 · modelagem em Go"); contracts api-biblioteca.md with English names.

const (
	maxPartBytes  = 25 << 20
	maxBatchItems = 100
	maxBatchParts = 200
)

var (
	partName = regexp.MustCompile(`^(text|source|transcript|exam|highlights|documents|course|artifacts/[A-Za-z0-9_-]{1,64})$`)
	safeID   = regexp.MustCompile(`^[A-Za-z0-9_-]{1,80}$`)
	// keys the index may never carry with a value (the server refuses it)
	keyName = regexp.MustCompile(`(?i)api[_-]?key$`)
)

// errStale is a write based on a version that is not the current one any more.
var errStale = errors.New("stale")

func (srv *Server) now() time.Time { return srv.cfg.Now().UTC() }

// ts is the stamp of the library tables: one fixed format, so they sort as text.
func ts(t time.Time) string { return t.UTC().Format(time.RFC3339) }

// withBlobs answers 503 when the storage is not configured, instead of failing in the middle.
func (srv *Server) withBlobs(handle handlerFunc) handlerFunc {
	return func(w http.ResponseWriter, r *http.Request, s *Session) {
		if srv.cfg.Blobs == nil {
			fail(w, http.StatusServiceUnavailable, "storage_unavailable", nil)
			return
		}
		handle(w, r, s)
	}
}

// mediaRef is the media of a note in the App.
type mediaRef struct {
	ID     string `json:"id"`
	Key    string `json:"key"`
	Mime   string `json:"mime"`
	Bytes  int64  `json:"bytes"`
	Status string `json:"status"`
}

// libraryRow is a row of the map as the API shows it.
type libraryRow struct {
	ID           string            `json:"id"`
	ItemKind     string            `json:"itemKind"`
	NoteType     *string           `json:"noteType"`
	Name         string            `json:"name"`
	FolderID     *string           `json:"folderId"`
	ParentFileID *string           `json:"parentFileId"`
	Place        *string           `json:"place"` // nil on a folder: only a note has a place (spec 005)
	Recording    bool              `json:"recording"`
	Position     float64           `json:"position"`
	Meta         json.RawMessage   `json:"meta"`
	Parts        map[string]string `json:"parts"`
	Media        *mediaRef         `json:"media"`
	NoteBytes    int64             `json:"noteBytes"`
	MediaBytes   int64             `json:"mediaBytes"`
	DriveRef     *string           `json:"driveRef"`
	CreatedAt    string            `json:"createdAt"`
	UpdatedAt    string            `json:"updatedAt"`
	TrashedAt    *string           `json:"trashedAt"`
	TrashedWith  *string           `json:"trashedWith"`
	RemovedAt    *string           `json:"removedAt"`
	Rev          int64             `json:"rev"`
	Seq          int64             `json:"seq"`
}

// rowFields are the fields of a row the app writes; parts, media, sizes, rev, seq and removedAt are the server's.
type rowFields struct {
	ItemKind     string          `json:"itemKind"`
	NoteType     *string         `json:"noteType"`
	Name         string          `json:"name"`
	FolderID     *string         `json:"folderId"`
	ParentFileID *string         `json:"parentFileId"`
	Place        string          `json:"place"` // ignored on a folder; "app" or "drive" on a note (spec 005)
	Recording    bool            `json:"recording"`
	Position     float64         `json:"position"`
	Meta         json.RawMessage `json:"meta"`
	DriveRef     *string         `json:"driveRef"`
	CreatedAt    string          `json:"createdAt"`
	UpdatedAt    string          `json:"updatedAt"`
	TrashedAt    *string         `json:"trashedAt"`
	TrashedWith  *string         `json:"trashedWith"`
}

const rowColumns = `id, item_kind, note_type, name, folder_id, parent_file_id, place, recording, position, meta, parts, media, note_bytes, media_bytes, drive_ref, created_at, updated_at, trashed_at, trashed_with, removed_at, rev, seq`

type scanner interface{ Scan(...any) error }

func scanRow(row scanner) (*libraryRow, error) {
	var out libraryRow
	var noteType, folderID, parentID, place, media, driveRef, trashedAt, trashedWith, removedAt sql.NullString
	var recording int
	var meta, parts string
	if err := row.Scan(&out.ID, &out.ItemKind, &noteType, &out.Name, &folderID, &parentID, &place, &recording, &out.Position, &meta, &parts, &media,
		&out.NoteBytes, &out.MediaBytes, &driveRef, &out.CreatedAt, &out.UpdatedAt, &trashedAt, &trashedWith, &removedAt, &out.Rev, &out.Seq); err != nil {
		return nil, err
	}
	str := func(value sql.NullString) *string {
		if !value.Valid {
			return nil
		}
		v := value.String
		return &v
	}
	out.NoteType, out.FolderID, out.ParentFileID, out.Place, out.DriveRef = str(noteType), str(folderID), str(parentID), str(place), str(driveRef)
	out.TrashedAt, out.TrashedWith, out.RemovedAt = str(trashedAt), str(trashedWith), str(removedAt)
	out.Recording = recording == 1
	out.Meta = json.RawMessage(meta)
	out.Parts = map[string]string{}
	_ = json.Unmarshal([]byte(parts), &out.Parts)
	if media.Valid {
		out.Media = &mediaRef{}
		if json.Unmarshal([]byte(media.String), out.Media) != nil {
			out.Media = nil
		}
	}
	return &out, nil
}

type querier interface {
	QueryRow(query string, args ...any) *sql.Row
	Exec(query string, args ...any) (sql.Result, error)
}

// findRow is the row of the account, or nil.
func findRow(q querier, userID, id string) (*libraryRow, error) {
	row, err := scanRow(q.QueryRow(`SELECT `+rowColumns+` FROM library_items WHERE user_id = ? AND id = ?`, userID, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return row, err
}

// nextSeq adds 1 to the account's count of changes and gives it, in the same transaction as the change.
func nextSeq(q querier, userID string) (int64, error) {
	var seq int64
	err := q.QueryRow(`UPDATE user SET seq = seq + 1 WHERE id = ? RETURNING seq`, userID).Scan(&seq)
	return seq, err
}

func orphan(q querier, userID, key, reason string, at time.Time) error {
	_, err := q.Exec(`INSERT INTO orphans (object_key, user_id, reason, since) VALUES (?, ?, ?, ?) ON CONFLICT (object_key) DO NOTHING`, key, userID, reason, ts(at))
	return err
}

// newVersion orders by time: <ms in base 36>-<4 random>.
func (srv *Server) newVersion() string {
	return strconv.FormatInt(srv.now().UnixMilli(), 36) + "-" + strings.ToLower(randomToken(4))[:4]
}

func partKey(userID, itemID, part, version string) string {
	if part == "course" {
		return fmt.Sprintf("u/%s/f/%s/course/%s.json", userID, itemID, version)
	}
	ext := "json"
	if part == "text" {
		ext = "md"
	}
	return fmt.Sprintf("u/%s/i/%s/%s/%s.%s", userID, itemID, part, version, ext)
}

func indexKey(userID, version string) string {
	return fmt.Sprintf("u/%s/index/%s.json", userID, version)
}

// cleanMeta drops from the map what lives in the parts "source" and "course": the text never goes in the map.
func cleanMeta(raw json.RawMessage) (string, error) {
	meta := map[string]any{}
	if len(raw) > 0 && string(raw) != "null" {
		if err := json.Unmarshal(raw, &meta); err != nil {
			return "", err
		}
	}
	for _, key := range []string{"sourceExcerpt", "pendingExcerpt", "courseMaterial", "courseDescription"} {
		if _, ok := meta[key]; ok {
			meta[key] = nil
		}
	}
	if source, ok := meta["source"].(map[string]any); ok {
		delete(source, "text")
	}
	out, err := json.Marshal(meta)
	return string(out), err
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

// cycles says whether the new mother (note) or the new folder (folder) would make the item its own ancestor.
func cycles(q querier, userID, id string, fields rowFields) bool {
	column, start := "parent_file_id", fields.ParentFileID
	if fields.ItemKind == "folder" {
		column, start = "folder_id", fields.FolderID
	}
	seen := map[string]bool{}
	for next := start; next != nil && *next != ""; {
		if *next == id || seen[*next] {
			return true
		}
		seen[*next] = true
		var parent sql.NullString
		if err := q.QueryRow(`SELECT `+column+` FROM library_items WHERE user_id = ? AND id = ? AND removed_at IS NULL`, userID, *next).Scan(&parent); err != nil || !parent.Valid {
			return false
		}
		value := parent.String
		next = &value
	}
	return false
}

// rowError is a refusal of one row: a conflict (with the current row), a cycle, or a name already in the folder (with that item).
type rowError struct {
	code    string
	current *libraryRow
}

// nameKey is what tells two names apart in a folder (spec 005, FR-021): capitals and the spaces at the ends do not.
func nameKey(name string) string { return strings.ToLower(strings.TrimSpace(name)) }

func folderKey(id *string) string {
	if id == nil {
		return ""
	}
	return *id
}

func trashed(at *string) bool { return at != nil && *at != "" }

// nameTaken is the live item of the same kind with the same name in the folder the row goes to (the root too), when the write brings
// the name there: a new item, a new name or folder, back from the Trash. A pair that existed before the rule keeps taking its other
// changes (T052 joins them); what is in the Trash does not count.
func nameTaken(tx *sql.Tx, userID, id string, current *libraryRow, fields rowFields) (*libraryRow, error) {
	if trashed(fields.TrashedAt) {
		return nil, nil
	}
	if current != nil && current.RemovedAt == nil && !trashed(current.TrashedAt) && current.ItemKind == fields.ItemKind && folderKey(current.FolderID) == folderKey(fields.FolderID) && nameKey(current.Name) == nameKey(fields.Name) {
		return nil, nil
	}
	rows, err := tx.Query(`SELECT id, name FROM library_items WHERE user_id = ? AND item_kind = ? AND id != ? AND removed_at IS NULL AND (trashed_at IS NULL OR trashed_at = '') AND COALESCE(folder_id, '') = ?`,
		userID, fields.ItemKind, id, folderKey(fields.FolderID))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	key := nameKey(fields.Name)
	for rows.Next() {
		var other libraryRow
		if err := rows.Scan(&other.ID, &other.Name); err != nil {
			return nil, err
		}
		if nameKey(other.Name) == key {
			return &other, nil
		}
	}
	return nil, rows.Err()
}

func (e *rowError) Error() string { return e.code }

// applyRow writes the app's fields of one row, if it is still at baseRev. A folder has no place; a note is in the App only with
// the structure on (spec 005).
func (srv *Server) applyRow(tx *sql.Tx, userID, id string, baseRev int64, fields rowFields, seq int64, structure bool) (int64, error) {
	if !safeID.MatchString(id) {
		return 0, &rowError{code: "invalid_id"}
	}
	if (fields.ItemKind != "file" && fields.ItemKind != "folder") || strings.TrimSpace(fields.Name) == "" {
		return 0, &rowError{code: "invalid_row"}
	}
	var place *string
	if fields.ItemKind == "file" {
		if fields.Place != "app" && fields.Place != "drive" {
			return 0, &rowError{code: "invalid_place"}
		}
		if fields.Place == "app" && !structure {
			return 0, &rowError{code: "app_off"}
		}
		place = &fields.Place
	}
	current, err := findRow(tx, userID, id)
	if err != nil {
		return 0, err
	}
	rev := int64(0)
	if current != nil {
		rev = current.Rev
	}
	if rev != baseRev {
		return 0, &rowError{code: "conflict", current: current}
	}
	if cycles(tx, userID, id, fields) {
		return 0, &rowError{code: "cycle"}
	}
	if taken, err := nameTaken(tx, userID, id, current, fields); err != nil {
		return 0, err
	} else if taken != nil {
		return 0, &rowError{code: "name_taken", current: taken}
	}
	meta, err := cleanMeta(fields.Meta)
	if err != nil {
		return 0, &rowError{code: "invalid_row"}
	}
	now := ts(srv.now())
	if fields.CreatedAt == "" {
		fields.CreatedAt = now
	}
	if fields.UpdatedAt == "" {
		fields.UpdatedAt = now
	}
	_, err = tx.Exec(`INSERT INTO library_items (user_id, id, item_kind, note_type, name, folder_id, parent_file_id, place, recording, position, meta, drive_ref, created_at, updated_at, trashed_at, trashed_with, rev, seq)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
		ON CONFLICT (user_id, id) DO UPDATE SET item_kind = excluded.item_kind, note_type = excluded.note_type, name = excluded.name, folder_id = excluded.folder_id,
		parent_file_id = excluded.parent_file_id, place = excluded.place, recording = excluded.recording, position = excluded.position,
		meta = excluded.meta, drive_ref = excluded.drive_ref, created_at = excluded.created_at, updated_at = excluded.updated_at, trashed_at = excluded.trashed_at,
		trashed_with = excluded.trashed_with, removed_at = NULL, rev = library_items.rev + 1, seq = excluded.seq`,
		userID, id, fields.ItemKind, fields.NoteType, fields.Name, fields.FolderID, fields.ParentFileID, place, boolInt(fields.Recording),
		fields.Position, meta, fields.DriveRef, fields.CreatedAt, fields.UpdatedAt, fields.TrashedAt, fields.TrashedWith, seq)
	if err != nil {
		return 0, err
	}
	return rev + 1, nil
}

func (srv *Server) rowRefusal(w http.ResponseWriter, err error) bool {
	var refusal *rowError
	if !errors.As(err, &refusal) {
		return false
	}
	switch refusal.code {
	case "conflict":
		fail(w, http.StatusConflict, "conflict", map[string]any{"current": refusal.current})
	case "name_taken":
		fail(w, http.StatusConflict, "name_taken", map[string]any{"taken": map[string]any{"id": refusal.current.ID, "name": refusal.current.Name}})
	case "cycle", "invalid_place":
		fail(w, http.StatusUnprocessableEntity, refusal.code, nil)
	case "app_off":
		fail(w, http.StatusForbidden, "app_off", nil)
	default:
		fail(w, http.StatusBadRequest, refusal.code, nil)
	}
	return true
}

// libraryMap: the whole map (since=0) or what changed since, in order of seq, with tombstones, page by page.
func (srv *Server) libraryMap(w http.ResponseWriter, r *http.Request, s *Session) {
	since, _ := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 1000 {
		limit = 1000
	}
	var seq int64
	if err := srv.read.QueryRow(`SELECT seq FROM user WHERE id = ?`, s.User.ID).Scan(&seq); err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	rows, err := srv.read.Query(`SELECT `+rowColumns+` FROM library_items WHERE user_id = ? AND seq > ? ORDER BY seq, id LIMIT ?`, s.User.ID, since, limit+1)
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	defer rows.Close()
	out := []*libraryRow{}
	for rows.Next() {
		row, err := scanRow(rows)
		if err != nil {
			fail(w, http.StatusInternalServerError, "internal_error", nil)
			return
		}
		out = append(out, row)
	}
	more := len(out) > limit
	if more {
		out = out[:limit]
	}
	writeJSON(w, http.StatusOK, map[string]any{"seq": seq, "rows": out, "more": more})
}

func (srv *Server) getLibraryItem(w http.ResponseWriter, r *http.Request, s *Session) {
	row, err := findRow(srv.read, s.User.ID, r.PathValue("id"))
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	if row == nil {
		fail(w, http.StatusNotFound, "not_found", nil)
		return
	}
	writeJSON(w, http.StatusOK, row)
}

func (srv *Server) putLibraryItem(w http.ResponseWriter, r *http.Request, s *Session) {
	var body struct {
		BaseRev int64     `json:"baseRev"`
		Row     rowFields `json:"row"`
	}
	if !readJSON(r, &body) {
		fail(w, http.StatusBadRequest, "invalid_body", nil)
		return
	}
	tx, err := srv.db.Begin()
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	defer tx.Rollback()
	seq, err := nextSeq(tx, s.User.ID)
	if err == nil {
		var rev int64
		rev, err = srv.applyRow(tx, s.User.ID, r.PathValue("id"), body.BaseRev, body.Row, seq, structureOn(s.User))
		if err == nil && tx.Commit() == nil {
			srv.notifyMap(s.User.ID, seq)
			writeJSON(w, http.StatusOK, map[string]any{"rev": rev, "seq": seq})
			return
		}
	}
	if !srv.rowRefusal(w, err) {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
	}
}

// libraryBatch: up to 100 rows, all or nothing (move many, "Apagar tudo", restore from the Trash).
func (srv *Server) libraryBatch(w http.ResponseWriter, r *http.Request, s *Session) {
	var body struct {
		Operations []struct {
			ID      string    `json:"id"`
			BaseRev int64     `json:"baseRev"`
			Row     rowFields `json:"row"`
		} `json:"operations"`
	}
	if !readJSON(r, &body) || len(body.Operations) == 0 || len(body.Operations) > maxBatchItems {
		fail(w, http.StatusBadRequest, "invalid_body", nil)
		return
	}
	tx, err := srv.db.Begin()
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	defer tx.Rollback()
	seq, err := nextSeq(tx, s.User.ID)
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	revs := map[string]int64{}
	currents := []*libraryRow{}
	for _, op := range body.Operations {
		rev, err := srv.applyRow(tx, s.User.ID, op.ID, op.BaseRev, op.Row, seq, structureOn(s.User))
		var refusal *rowError
		switch {
		case errors.As(err, &refusal) && refusal.code == "conflict":
			currents = append(currents, refusal.current)
		case err != nil:
			if !srv.rowRefusal(w, err) {
				fail(w, http.StatusInternalServerError, "internal_error", nil)
			}
			return
		default:
			revs[op.ID] = rev
		}
	}
	if len(currents) > 0 {
		fail(w, http.StatusConflict, "conflict", map[string]any{"currents": currents})
		return
	}
	if tx.Commit() != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	srv.notifyMap(s.User.ID, seq)
	writeJSON(w, http.StatusOK, map[string]any{"revs": revs, "seq": seq})
}

// deleteLibraryItem: deleted for good (emptying the Trash): a tombstone; the parts and the media go to the orphans; the space goes down.
func (srv *Server) deleteLibraryItem(w http.ResponseWriter, r *http.Request, s *Session) {
	id := r.PathValue("id")
	baseRev, _ := strconv.ParseInt(r.URL.Query().Get("baseRev"), 10, 64)
	tx, err := srv.db.Begin()
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	defer tx.Rollback()
	row, err := findRow(tx, s.User.ID, id)
	if err != nil || row == nil || row.RemovedAt != nil {
		fail(w, http.StatusNotFound, "not_found", nil)
		return
	}
	if row.Rev != baseRev {
		fail(w, http.StatusConflict, "conflict", map[string]any{"current": row})
		return
	}
	now := srv.now()
	for part, version := range row.Parts {
		if err := orphan(tx, s.User.ID, partKey(s.User.ID, id, part, version), "removed", now); err != nil {
			fail(w, http.StatusInternalServerError, "internal_error", nil)
			return
		}
	}
	mediaBytes := int64(0)
	if row.Media != nil && row.Media.Status == "stored" {
		mediaBytes = row.MediaBytes
		_ = orphan(tx, s.User.ID, row.Media.Key, "removed", now)
	}
	seq, err := nextSeq(tx, s.User.ID)
	if err == nil {
		_, err = tx.Exec(`UPDATE library_items SET removed_at = ?, parts = '{}', media = NULL, note_bytes = 0, media_bytes = 0, rev = rev + 1, seq = ? WHERE user_id = ? AND id = ?`, ts(now), seq, s.User.ID, id)
	}
	if err == nil {
		_, err = tx.Exec(`UPDATE user SET notes_bytes = MAX(0, notes_bytes - ?), media_bytes = MAX(0, media_bytes - ?) WHERE id = ?`, row.NoteBytes, mediaBytes, s.User.ID)
	}
	if err != nil || tx.Commit() != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	srv.notifyMap(s.User.ID, seq)
	srv.notifySpace(s.User.ID)
	writeJSON(w, http.StatusOK, map[string]any{"seq": seq})
}

// precondition reads If-Match / If-None-Match: the version the write was based on ("" = nothing there yet); ok false = no header.
func precondition(r *http.Request) (string, bool) {
	if r.Header.Get("If-None-Match") == "*" {
		return "", true
	}
	match := strings.Trim(strings.TrimPrefix(strings.TrimSpace(r.Header.Get("If-Match")), "W/"), `"`)
	return match, match != ""
}

func readBody(r *http.Request, max int64) ([]byte, bool) {
	body, err := io.ReadAll(io.LimitReader(r.Body, max+1))
	return body, err == nil && int64(len(body)) <= max
}

func contentTypeOf(part string) string {
	if part == "text" {
		return "text/markdown; charset=utf-8"
	}
	return "application/json"
}

func (srv *Server) getPart(w http.ResponseWriter, r *http.Request, s *Session) {
	id, part := r.PathValue("id"), r.PathValue("part")
	row, err := findRow(srv.db, s.User.ID, id)
	if err != nil || row == nil || row.RemovedAt != nil || !partName.MatchString(part) {
		fail(w, http.StatusNotFound, "part_not_found", nil)
		return
	}
	version := r.URL.Query().Get("version")
	if version == "" {
		version = row.Parts[part]
	}
	if version == "" || !safeID.MatchString(version) {
		fail(w, http.StatusNotFound, "part_not_found", nil)
		return
	}
	reader, _, err := srv.cfg.Blobs.Get(r.Context(), partKey(s.User.ID, id, part, version), nil)
	if err != nil {
		fail(w, http.StatusNotFound, "part_not_found", nil)
		return
	}
	defer reader.Close()
	h := w.Header()
	h.Set("Content-Type", contentTypeOf(part))
	h.Set("ETag", `"`+version+`"`)
	h.Set("Cache-Control", "private, max-age=31536000, immutable")
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, reader)
}

// sizeOf is the size of a stored object (0 when it is not there).
func (srv *Server) sizeOf(ctx context.Context, key string) int64 {
	info, err := srv.cfg.Blobs.Head(ctx, key)
	if err != nil {
		return 0
	}
	return info.Size
}

// putPart writes a new version of a part when it is still at the version the device edited; the old one goes to the orphans.
// Text is never refused for space (FR-044).
func (srv *Server) putPart(w http.ResponseWriter, r *http.Request, s *Session) {
	id, part := r.PathValue("id"), r.PathValue("part")
	if !partName.MatchString(part) {
		fail(w, http.StatusBadRequest, "invalid_part", nil)
		return
	}
	base, ok := precondition(r)
	if !ok {
		fail(w, http.StatusPreconditionRequired, "precondition_required", nil)
		return
	}
	body, ok := readBody(r, maxPartBytes)
	if !ok {
		fail(w, http.StatusRequestEntityTooLarge, "too_large", nil)
		return
	}
	row, err := findRow(srv.db, s.User.ID, id)
	if err != nil || row == nil || row.RemovedAt != nil {
		fail(w, http.StatusNotFound, "not_found", nil)
		return
	}
	if row.Parts[part] != base {
		fail(w, http.StatusConflict, "conflict", map[string]any{"currentVersion": nilIfEmpty(row.Parts[part])})
		return
	}
	version := srv.newVersion()
	key := partKey(s.User.ID, id, part, version)
	if err := srv.cfg.Blobs.Put(r.Context(), key, body, contentTypeOf(part), map[string]string{"user": s.User.ID, "item": id, "part": part}); err != nil {
		fail(w, http.StatusBadGateway, "storage_failed", nil)
		return
	}
	oldBytes := int64(0)
	if base != "" {
		oldBytes = srv.sizeOf(r.Context(), partKey(s.User.ID, id, part, base))
	}
	seq, err := srv.swapPart(s.User.ID, id, part, base, version, int64(len(body))-oldBytes)
	if errors.Is(err, errStale) {
		_ = srv.cfg.Blobs.Delete(r.Context(), key)
		current, _ := findRow(srv.db, s.User.ID, id)
		var now string
		if current != nil {
			now = current.Parts[part]
		}
		fail(w, http.StatusConflict, "conflict", map[string]any{"currentVersion": nilIfEmpty(now)})
		return
	}
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	srv.notifyMap(s.User.ID, seq)
	srv.notifySpace(s.User.ID)
	out := map[string]any{"version": version, "bytes": len(body), "seq": seq}
	if row.TrashedAt != nil {
		out["inTrash"] = true
	}
	writeJSON(w, http.StatusOK, out)
}

func nilIfEmpty(text string) any {
	if text == "" {
		return nil
	}
	return text
}

// swapPart moves a part from version `from` to `to` ("" removes it), in one transaction, with the sizes and the orphan.
func (srv *Server) swapPart(userID, id, part, from, to string, delta int64) (int64, error) {
	tx, err := srv.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	row, err := findRow(tx, userID, id)
	if err != nil {
		return 0, err
	}
	if row == nil || row.RemovedAt != nil || row.Parts[part] != from {
		return 0, errStale
	}
	if to == "" {
		delete(row.Parts, part)
	} else {
		row.Parts[part] = to
	}
	parts, _ := json.Marshal(row.Parts)
	seq, err := nextSeq(tx, userID)
	if err != nil {
		return 0, err
	}
	if _, err := tx.Exec(`UPDATE library_items SET parts = ?, note_bytes = MAX(0, note_bytes + ?), seq = ? WHERE user_id = ? AND id = ?`, string(parts), delta, seq, userID, id); err != nil {
		return 0, err
	}
	if _, err := tx.Exec(`UPDATE user SET notes_bytes = MAX(0, notes_bytes + ?) WHERE id = ?`, delta, userID); err != nil {
		return 0, err
	}
	if from != "" {
		reason := "replaced"
		if to == "" {
			reason = "removed"
		}
		if err := orphan(tx, userID, partKey(userID, id, part, from), reason, srv.now()); err != nil {
			return 0, err
		}
	}
	return seq, tx.Commit()
}

func (srv *Server) deletePart(w http.ResponseWriter, r *http.Request, s *Session) {
	id, part := r.PathValue("id"), r.PathValue("part")
	base, ok := precondition(r)
	if !partName.MatchString(part) || !ok || base == "" {
		fail(w, http.StatusBadRequest, "invalid_part", nil)
		return
	}
	size := srv.sizeOf(r.Context(), partKey(s.User.ID, id, part, base))
	seq, err := srv.swapPart(s.User.ID, id, part, base, "", -size)
	if errors.Is(err, errStale) {
		current, _ := findRow(srv.db, s.User.ID, id)
		if current == nil {
			fail(w, http.StatusNotFound, "part_not_found", nil)
			return
		}
		fail(w, http.StatusConflict, "conflict", map[string]any{"currentVersion": nilIfEmpty(current.Parts[part])})
		return
	}
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	srv.notifyMap(s.User.ID, seq)
	srv.notifySpace(s.User.ID)
	writeJSON(w, http.StatusOK, map[string]any{"seq": seq})
}

// partsBatch: up to 200 parts at once, one NDJSON line each (the text of the whole library on a new device).
func (srv *Server) partsBatch(w http.ResponseWriter, r *http.Request, s *Session) {
	var body struct {
		Requests []struct {
			Item    string `json:"item"`
			Part    string `json:"part"`
			Version string `json:"version"`
		} `json:"requests"`
	}
	if !readJSON(r, &body) || len(body.Requests) > maxBatchParts {
		fail(w, http.StatusBadRequest, "invalid_body", nil)
		return
	}
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.WriteHeader(http.StatusOK)
	encoder := json.NewEncoder(w)
	owned := map[string]bool{}
	for _, request := range body.Requests {
		line := map[string]any{"item": request.Item, "part": request.Part, "version": request.Version}
		mine, known := owned[request.Item]
		if !known {
			row, _ := findRow(srv.db, s.User.ID, request.Item)
			mine = row != nil
			owned[request.Item] = mine
		}
		content, found := []byte(nil), false
		if mine && partName.MatchString(request.Part) && safeID.MatchString(request.Version) {
			if reader, _, err := srv.cfg.Blobs.Get(r.Context(), partKey(s.User.ID, request.Item, request.Part, request.Version), nil); err == nil {
				content, _ = io.ReadAll(reader)
				reader.Close()
				found = true
			}
		}
		if found {
			line["content"] = string(content)
		} else {
			line["error"] = "part_not_found"
		}
		_ = encoder.Encode(line)
	}
}

func (srv *Server) getIndex(w http.ResponseWriter, r *http.Request, s *Session) {
	var version string
	if err := srv.db.QueryRow(`SELECT version FROM library_index WHERE user_id = ?`, s.User.ID).Scan(&version); err != nil {
		fail(w, http.StatusNotFound, "not_found", nil)
		return
	}
	reader, _, err := srv.cfg.Blobs.Get(r.Context(), indexKey(s.User.ID, version), nil)
	if err != nil {
		fail(w, http.StatusNotFound, "not_found", nil)
		return
	}
	defer reader.Close()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("ETag", `"`+version+`"`)
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, reader)
}

// hasKey finds an AI key with a value anywhere in the index.
func hasKey(value any) bool {
	switch v := value.(type) {
	case map[string]any:
		for key, item := range v {
			if text, ok := item.(string); ok && keyName.MatchString(key) && text != "" {
				return true
			}
			if hasKey(item) {
				return true
			}
		}
	case []any:
		for _, item := range v {
			if hasKey(item) {
				return true
			}
		}
	}
	return false
}

func (srv *Server) putIndex(w http.ResponseWriter, r *http.Request, s *Session) {
	base, ok := precondition(r)
	if !ok {
		fail(w, http.StatusPreconditionRequired, "precondition_required", nil)
		return
	}
	body, ok := readBody(r, maxPartBytes)
	var parsed any
	if !ok || json.Unmarshal(body, &parsed) != nil {
		fail(w, http.StatusBadRequest, "invalid_body", nil)
		return
	}
	if hasKey(parsed) {
		fail(w, http.StatusUnprocessableEntity, "key_in_index", nil)
		return
	}
	var current string
	var oldBytes int64
	_ = srv.db.QueryRow(`SELECT version, bytes FROM library_index WHERE user_id = ?`, s.User.ID).Scan(&current, &oldBytes)
	if current != base {
		fail(w, http.StatusConflict, "conflict", map[string]any{"currentVersion": nilIfEmpty(current)})
		return
	}
	version := srv.newVersion()
	if err := srv.cfg.Blobs.Put(r.Context(), indexKey(s.User.ID, version), body, "application/json", map[string]string{"user": s.User.ID, "part": "index"}); err != nil {
		fail(w, http.StatusBadGateway, "storage_failed", nil)
		return
	}
	tx, err := srv.db.Begin()
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	defer tx.Rollback()
	var now string
	_ = tx.QueryRow(`SELECT version FROM library_index WHERE user_id = ?`, s.User.ID).Scan(&now)
	if now != base {
		_ = srv.cfg.Blobs.Delete(r.Context(), indexKey(s.User.ID, version))
		fail(w, http.StatusConflict, "conflict", map[string]any{"currentVersion": nilIfEmpty(now)})
		return
	}
	size := int64(len(body))
	_, err = tx.Exec(`INSERT INTO library_index (user_id, version, bytes, updated_at) VALUES (?, ?, ?, ?)
		ON CONFLICT (user_id) DO UPDATE SET version = excluded.version, bytes = excluded.bytes, updated_at = excluded.updated_at`, s.User.ID, version, size, ts(srv.now()))
	if err == nil {
		_, err = tx.Exec(`UPDATE user SET notes_bytes = MAX(0, notes_bytes + ?) WHERE id = ?`, size-oldBytes, s.User.ID)
	}
	if err == nil && base != "" {
		err = orphan(tx, s.User.ID, indexKey(s.User.ID, base), "replaced", srv.now())
	}
	if err != nil || tx.Commit() != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	srv.notifySpace(s.User.ID)
	writeJSON(w, http.StatusOK, map[string]any{"version": version, "bytes": size})
}

var _ blobs.Store = (*blobs.Memory)(nil)
