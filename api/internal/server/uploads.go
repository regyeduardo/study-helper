package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/regyeduardo/study-helper/api/internal/blobs"
)

// Entrega 4 (spec 003, FR-018, FR-019, FR-044): media and files go to the App in parts that resume; until "complete" the note's
// media is `uploading`, never shown as kept. Reading takes Range, so the player starts without downloading it all.
// Contract api-arquivos.md with English names.

var (
	allowedMime = regexp.MustCompile(`^(video/|audio/|image/)[a-z0-9.+-]+$|^application/pdf$|^text/plain$`)
	safeExt     = regexp.MustCompile(`^\.[a-z0-9]{1,8}$`)
)

type upload struct {
	ID, UserID, ItemID, MediaID, Key, FileName, Mime, Status string
	Declared, PartSize                                       int64
}

func findUpload(q querier, userID, id string) (*upload, error) {
	var u upload
	err := q.QueryRow(`SELECT id, user_id, item_id, media_id, object_key, file_name, mime, status, declared_bytes, part_size FROM uploads WHERE id = ? AND user_id = ?`, id, userID).
		Scan(&u.ID, &u.UserID, &u.ItemID, &u.MediaID, &u.Key, &u.FileName, &u.Mime, &u.Status, &u.Declared, &u.PartSize)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return &u, err
}

type receivedPart struct {
	N     int    `json:"n"`
	ETag  string `json:"etag"`
	Bytes int64  `json:"-"`
}

func uploadParts(q interface {
	Query(string, ...any) (*sql.Rows, error)
}, id string) ([]receivedPart, error) {
	rows, err := q.Query(`SELECT n, etag, bytes FROM upload_parts WHERE upload_id = ? ORDER BY n`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	parts := []receivedPart{}
	for rows.Next() {
		var part receivedPart
		if err := rows.Scan(&part.N, &part.ETag, &part.Bytes); err != nil {
			return nil, err
		}
		parts = append(parts, part)
	}
	return parts, nil
}

// space is what the account uses and has reserved, read fresh.
func (srv *Server) space(q querier, userID string) (notes, media, reserved int64, err error) {
	err = q.QueryRow(`SELECT notes_bytes, media_bytes, reserved_bytes FROM user WHERE id = ?`, userID).Scan(&notes, &media, &reserved)
	return
}

func setMedia(q querier, userID, itemID string, media *mediaRef, mediaBytes int64, seq int64) error {
	var value any
	if media != nil {
		raw, _ := json.Marshal(media)
		value = string(raw)
	}
	_, err := q.Exec(`UPDATE library_items SET media = ?, media_bytes = ?, seq = ? WHERE user_id = ? AND id = ?`, value, mediaBytes, seq, userID, itemID)
	return err
}

// startUpload reserves the space and opens the upload; the same media again gives back the open one with its parts (resume).
func (srv *Server) startUpload(w http.ResponseWriter, r *http.Request, s *Session) {
	var body struct {
		Item  string `json:"item"`
		Media string `json:"media"`
		Name  string `json:"name"`
		Mime  string `json:"mime"`
		Bytes int64  `json:"bytes"`
	}
	if !readJSON(r, &body) || !safeID.MatchString(body.Media) || body.Bytes <= 0 || strings.TrimSpace(body.Name) == "" {
		fail(w, http.StatusBadRequest, "invalid_body", nil)
		return
	}
	mime := strings.ToLower(strings.TrimSpace(strings.SplitN(body.Mime, ";", 2)[0]))
	if !allowedMime.MatchString(mime) {
		fail(w, http.StatusUnsupportedMediaType, "type_refused", nil)
		return
	}
	row, err := findRow(srv.db, s.User.ID, body.Item)
	if err != nil || row == nil || row.RemovedAt != nil || row.ItemKind != "file" {
		fail(w, http.StatusNotFound, "not_found", nil)
		return
	}
	var open string
	if srv.db.QueryRow(`SELECT id FROM uploads WHERE user_id = ? AND item_id = ? AND media_id = ? AND status = 'open'`, s.User.ID, body.Item, body.Media).Scan(&open) == nil {
		u, _ := findUpload(srv.db, s.User.ID, open)
		parts, _ := uploadParts(srv.db, open)
		writeJSON(w, http.StatusOK, map[string]any{"upload": open, "partSize": u.PartSize, "parts": parts})
		return
	}
	notes, media, reserved, err := srv.space(srv.db, s.User.ID)
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	if free := spaceLimit - notes - media - reserved; body.Bytes > free {
		if free < 0 {
			free = 0
		}
		fail(w, http.StatusRequestEntityTooLarge, "no_space", map[string]any{"missing": body.Bytes - free, "free": free})
		return
	}
	ext := strings.ToLower(filepath.Ext(body.Name))
	if !safeExt.MatchString(ext) {
		ext = ""
	}
	key := fmt.Sprintf("u/%s/i/%s/media/%s%s", s.User.ID, body.Item, body.Media, ext)
	id, err := srv.cfg.Blobs.CreateMultipart(r.Context(), key, mime, map[string]string{"user": s.User.ID, "item": body.Item, "part": "media"})
	if err != nil {
		fail(w, http.StatusBadGateway, "storage_failed", nil)
		return
	}
	tx, err := srv.db.Begin()
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	defer tx.Rollback()
	now := ts(srv.now())
	_, err = tx.Exec(`INSERT INTO uploads (id, user_id, item_id, media_id, object_key, file_name, mime, declared_bytes, part_size, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, s.User.ID, body.Item, body.Media, key, body.Name, mime, body.Bytes, srv.cfg.PartSize, now, now)
	var seq int64
	if err == nil {
		_, err = tx.Exec(`UPDATE user SET reserved_bytes = reserved_bytes + ? WHERE id = ?`, body.Bytes, s.User.ID)
	}
	if err == nil {
		seq, err = nextSeq(tx, s.User.ID)
	}
	if err == nil {
		// the media already kept keeps counting until the new one completes
		err = setMedia(tx, s.User.ID, body.Item, &mediaRef{ID: body.Media, Key: key, Mime: mime, Bytes: body.Bytes, Status: "uploading"}, row.MediaBytes, seq)
	}
	if err != nil || tx.Commit() != nil {
		_ = srv.cfg.Blobs.AbortMultipart(r.Context(), key, id)
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	srv.notifyMap(s.User.ID, seq)
	srv.notifySpace(s.User.ID)
	writeJSON(w, http.StatusCreated, map[string]any{"upload": id, "partSize": srv.cfg.PartSize, "parts": []receivedPart{}})
}

func (srv *Server) getUpload(w http.ResponseWriter, r *http.Request, s *Session) {
	u, err := findUpload(srv.db, s.User.ID, r.PathValue("id"))
	if err != nil || u == nil {
		fail(w, http.StatusNotFound, "not_found", nil)
		return
	}
	parts, _ := uploadParts(srv.db, u.ID)
	writeJSON(w, http.StatusOK, map[string]any{"parts": parts, "partSize": u.PartSize, "bytes": u.Declared, "status": u.Status})
}

// putUploadPart takes part n (1 to 10000), at most partSize; sending a part again replaces it.
func (srv *Server) putUploadPart(w http.ResponseWriter, r *http.Request, s *Session) {
	u, err := findUpload(srv.db, s.User.ID, r.PathValue("id"))
	if err != nil || u == nil || u.Status != "open" {
		fail(w, http.StatusNotFound, "not_found", nil)
		return
	}
	n, err := strconv.Atoi(r.PathValue("n"))
	if err != nil || n < 1 || n > 10000 {
		fail(w, http.StatusBadRequest, "invalid_part", nil)
		return
	}
	body, ok := readBody(r, u.PartSize)
	if !ok {
		fail(w, http.StatusRequestEntityTooLarge, "larger_than_part", nil)
		return
	}
	var others int64
	_ = srv.db.QueryRow(`SELECT COALESCE(SUM(bytes), 0) FROM upload_parts WHERE upload_id = ? AND n <> ?`, u.ID, n).Scan(&others)
	if others+int64(len(body)) > u.Declared {
		fail(w, http.StatusRequestEntityTooLarge, "larger_than_declared", nil)
		return
	}
	// a part never waits forever on the storage (23/11: an upload looked stuck): past the limit it fails, and the app sends it again
	limit := srv.cfg.PartTimeout
	if limit <= 0 {
		limit = 2 * time.Minute
	}
	ctx, cancel := context.WithTimeout(r.Context(), limit)
	defer cancel()
	etag, err := srv.cfg.Blobs.UploadPart(ctx, u.Key, u.ID, n, body)
	if err != nil {
		fail(w, http.StatusBadGateway, "storage_failed", nil)
		return
	}
	now := ts(srv.now())
	if _, err := srv.db.Exec(`INSERT INTO upload_parts (upload_id, n, etag, bytes, received_at) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT (upload_id, n) DO UPDATE SET etag = excluded.etag, bytes = excluded.bytes, received_at = excluded.received_at`, u.ID, n, etag, len(body), now); err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	_, _ = srv.db.Exec(`UPDATE uploads SET updated_at = ? WHERE id = ?`, now, u.ID)
	writeJSON(w, http.StatusOK, map[string]any{"n": n, "etag": etag})
}

// completeUpload closes the multipart: the reservation becomes used space by the real size, and the media is `stored`.
func (srv *Server) completeUpload(w http.ResponseWriter, r *http.Request, s *Session) {
	u, err := findUpload(srv.db, s.User.ID, r.PathValue("id"))
	if err != nil || u == nil || u.Status != "open" {
		fail(w, http.StatusNotFound, "not_found", nil)
		return
	}
	parts, err := uploadParts(srv.db, u.ID)
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	var total int64
	list := make([]blobs.Part, 0, len(parts))
	for i, part := range parts {
		if part.N != i+1 {
			break
		}
		total += part.Bytes
		list = append(list, blobs.Part{N: part.N, ETag: part.ETag})
	}
	if total != u.Declared || len(list) != len(parts) {
		fail(w, http.StatusConflict, "parts_missing", map[string]any{"received": total, "bytes": u.Declared})
		return
	}
	if err := srv.cfg.Blobs.CompleteMultipart(r.Context(), u.Key, u.ID, list); err != nil {
		fail(w, http.StatusBadGateway, "storage_failed", nil)
		return
	}
	tx, err := srv.db.Begin()
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	defer tx.Rollback()
	row, err := findRow(tx, s.User.ID, u.ItemID)
	if err != nil || row == nil {
		fail(w, http.StatusNotFound, "not_found", nil)
		return
	}
	now := srv.now()
	// a media kept before (replaced by this one) stops counting and goes to the orphans
	replaced := int64(0)
	if row.MediaBytes > 0 {
		replaced = row.MediaBytes
		var oldKey string
		if tx.QueryRow(`SELECT object_key FROM uploads WHERE user_id = ? AND item_id = ? AND status = 'completed' AND object_key <> ? ORDER BY updated_at DESC LIMIT 1`, s.User.ID, u.ItemID, u.Key).Scan(&oldKey) == nil {
			_ = orphan(tx, s.User.ID, oldKey, "replaced", now)
		}
	}
	seq, err := nextSeq(tx, s.User.ID)
	if err == nil {
		_, err = tx.Exec(`UPDATE uploads SET status = 'completed', updated_at = ? WHERE id = ?`, ts(now), u.ID)
	}
	if err == nil {
		_, err = tx.Exec(`UPDATE user SET reserved_bytes = MAX(0, reserved_bytes - ?), media_bytes = MAX(0, media_bytes + ? - ?) WHERE id = ?`, u.Declared, total, replaced, s.User.ID)
	}
	if err == nil {
		err = setMedia(tx, s.User.ID, u.ItemID, &mediaRef{ID: u.MediaID, Key: u.Key, Mime: u.Mime, Bytes: total, Status: "stored"}, total, seq)
	}
	if err != nil || tx.Commit() != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	srv.notifyMap(s.User.ID, seq)
	srv.notifySpace(s.User.ID)
	writeJSON(w, http.StatusOK, map[string]any{"key": u.Key, "bytes": total, "mime": u.Mime})
}

// abandonUpload gives up: the storage's half-upload is undone, the reservation freed, the note's media back to what it was.
func (srv *Server) abandonUpload(w http.ResponseWriter, r *http.Request, s *Session) {
	u, err := findUpload(srv.db, s.User.ID, r.PathValue("id"))
	if err != nil || u == nil || u.Status != "open" {
		fail(w, http.StatusNotFound, "not_found", nil)
		return
	}
	seq, err := srv.dropUpload(u)
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	_ = srv.cfg.Blobs.AbortMultipart(r.Context(), u.Key, u.ID)
	srv.notifyMap(s.User.ID, seq)
	srv.notifySpace(s.User.ID)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// dropUpload marks an open upload abandoned and frees its reservation (the caller aborts it in the storage).
func (srv *Server) dropUpload(u *upload) (int64, error) {
	tx, err := srv.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	seq, err := nextSeq(tx, u.UserID)
	if err != nil {
		return 0, err
	}
	if _, err := tx.Exec(`UPDATE uploads SET status = 'abandoned', updated_at = ? WHERE id = ?`, ts(srv.now()), u.ID); err != nil {
		return 0, err
	}
	if _, err := tx.Exec(`UPDATE user SET reserved_bytes = MAX(0, reserved_bytes - ?) WHERE id = ?`, u.Declared, u.UserID); err != nil {
		return 0, err
	}
	row, err := findRow(tx, u.UserID, u.ItemID)
	if err != nil {
		return 0, err
	}
	if row != nil && row.Media != nil && row.Media.ID == u.MediaID && row.Media.Status == "uploading" {
		// a media kept before this upload comes back; with none, the note has no media again
		var previous *mediaRef
		if row.MediaBytes > 0 {
			var p mediaRef
			if tx.QueryRow(`SELECT media_id, object_key, mime FROM uploads WHERE user_id = ? AND item_id = ? AND status = 'completed' ORDER BY updated_at DESC LIMIT 1`, u.UserID, u.ItemID).Scan(&p.ID, &p.Key, &p.Mime) == nil {
				p.Bytes, p.Status = row.MediaBytes, "stored"
				previous = &p
			}
		}
		if err := setMedia(tx, u.UserID, u.ItemID, previous, row.MediaBytes, seq); err != nil {
			return 0, err
		}
	}
	return seq, tx.Commit()
}

// parseRange reads "bytes=a-b", "bytes=a-" and "bytes=-n"; ok false = cannot be served (416).
func parseRange(header string, size int64) (*blobs.Range, bool) {
	spec, found := strings.CutPrefix(strings.TrimSpace(header), "bytes=")
	if !found || strings.Contains(spec, ",") {
		return nil, false
	}
	first, last, found := strings.Cut(spec, "-")
	if !found {
		return nil, false
	}
	if first == "" {
		n, err := strconv.ParseInt(last, 10, 64)
		if err != nil || n <= 0 {
			return nil, false
		}
		if n > size {
			n = size
		}
		return &blobs.Range{Start: size - n, End: size - 1}, size > 0
	}
	start, err := strconv.ParseInt(first, 10, 64)
	if err != nil || start >= size {
		return nil, false
	}
	end := size - 1
	if last != "" {
		end, err = strconv.ParseInt(last, 10, 64)
		if err != nil || end < start {
			return nil, false
		}
		if end > size-1 {
			end = size - 1
		}
	}
	return &blobs.Range{Start: start, End: end}, true
}

// getMedia (GET and HEAD): the stored media, with Range for the player; `?download=1` downloads with the file's name.
func (srv *Server) getMedia(w http.ResponseWriter, r *http.Request, s *Session) {
	row, err := findRow(srv.db, s.User.ID, r.PathValue("item"))
	if err != nil || row == nil || row.RemovedAt != nil || row.Media == nil || row.Media.ID != r.PathValue("media") {
		fail(w, http.StatusNotFound, "not_found", nil)
		return
	}
	switch row.Media.Status {
	case "deleted":
		fail(w, http.StatusGone, "media_deleted", nil)
		return
	case "stored":
	default:
		// half an upload is never shown as kept
		fail(w, http.StatusNotFound, "not_found", nil)
		return
	}
	info, err := srv.cfg.Blobs.Head(r.Context(), row.Media.Key)
	if err != nil {
		fail(w, http.StatusNotFound, "not_found", nil)
		return
	}
	h := w.Header()
	h.Set("Content-Type", row.Media.Mime)
	h.Set("Accept-Ranges", "bytes")
	// the player streams it from the app's page (crossorigin="use-credentials"): the parts' headers are readable there too
	h.Set("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length, ETag")
	h.Set("Cache-Control", "private, max-age=3600")
	if info.ETag != "" {
		h.Set("ETag", info.ETag)
	}
	if !info.LastModified.IsZero() {
		h.Set("Last-Modified", info.LastModified.UTC().Format(http.TimeFormat))
	}
	if r.URL.Query().Get("download") == "1" {
		name := row.Name
		_ = srv.db.QueryRow(`SELECT file_name FROM uploads WHERE user_id = ? AND object_key = ? AND status = 'completed' ORDER BY updated_at DESC LIMIT 1`, s.User.ID, row.Media.Key).Scan(&name)
		h.Set("Content-Disposition", "attachment; filename*=UTF-8''"+strings.ReplaceAll(url.QueryEscape(name), "+", "%20"))
	}
	var rng *blobs.Range
	status := http.StatusOK
	length := info.Size
	if header := r.Header.Get("Range"); header != "" {
		parsed, ok := parseRange(header, info.Size)
		if !ok {
			h.Set("Content-Range", fmt.Sprintf("bytes */%d", info.Size))
			fail(w, http.StatusRequestedRangeNotSatisfiable, "range_not_satisfiable", nil)
			return
		}
		rng, status, length = parsed, http.StatusPartialContent, parsed.End-parsed.Start+1
		h.Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", parsed.Start, parsed.End, info.Size))
	}
	h.Set("Content-Length", strconv.FormatInt(length, 10))
	if r.Method == http.MethodHead {
		w.WriteHeader(status)
		return
	}
	reader, _, err := srv.cfg.Blobs.Get(r.Context(), row.Media.Key, rng)
	if err != nil {
		fail(w, http.StatusBadGateway, "storage_failed", nil)
		return
	}
	defer reader.Close()
	w.WriteHeader(status)
	_, _ = io.Copy(w, reader)
}

// deleteMedia deletes the media and keeps the note, marked "mídia apagada" (the note goes on existing).
func (srv *Server) deleteMedia(w http.ResponseWriter, r *http.Request, s *Session) {
	tx, err := srv.db.Begin()
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	defer tx.Rollback()
	row, err := findRow(tx, s.User.ID, r.PathValue("item"))
	if err != nil || row == nil || row.RemovedAt != nil || row.Media == nil || row.Media.ID != r.PathValue("media") || row.Media.Status == "deleted" {
		fail(w, http.StatusNotFound, "not_found", nil)
		return
	}
	seq, err := nextSeq(tx, s.User.ID)
	if err == nil {
		err = orphan(tx, s.User.ID, row.Media.Key, "removed", srv.now())
	}
	if err == nil {
		_, err = tx.Exec(`UPDATE user SET media_bytes = MAX(0, media_bytes - ?) WHERE id = ?`, row.MediaBytes, s.User.ID)
	}
	if err == nil {
		gone := *row.Media
		gone.Status = "deleted"
		err = setMedia(tx, s.User.ID, row.ID, &gone, 0, seq)
	}
	if err != nil || tx.Commit() != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	srv.notifyMap(s.User.ID, seq)
	srv.notifySpace(s.User.ID)
	writeJSON(w, http.StatusOK, map[string]any{"seq": seq})
}
