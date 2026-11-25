package server

import (
	"context"
	"database/sql"
	"net/http"
	"strings"
	"time"
)

// Entrega 4 (spec 003, FR-044, SC-016, R6): the space used must always be right. It changes with each write, and CheckUsage, run
// once a day, compares it with what is kept for real, fixes it and writes down the difference. Clean deletes from the storage what
// nothing points to after 31 days, gives up uploads open for 7 days and drops tombstones after 60 days.

const (
	orphanDays    = 31
	openUploadAge = 7 * 24 * time.Hour
	tombstoneDays = 60
)

// CheckUsage recounts every account's notes, media and reservations from the map, the index and the open uploads.
func (srv *Server) CheckUsage(ctx context.Context) error {
	rows, err := srv.db.QueryContext(ctx, `SELECT id, notes_bytes + media_bytes + reserved_bytes FROM user`)
	if err != nil {
		return err
	}
	type account struct {
		id     string
		stored int64
	}
	var accounts []account
	for rows.Next() {
		var a account
		if err := rows.Scan(&a.id, &a.stored); err != nil {
			rows.Close()
			return err
		}
		accounts = append(accounts, a)
	}
	rows.Close()
	now := ts(srv.now())
	for _, a := range accounts {
		var notes, media, index, reserved int64
		if err := srv.db.QueryRowContext(ctx, `SELECT COALESCE(SUM(note_bytes), 0), COALESCE(SUM(media_bytes), 0) FROM library_items WHERE user_id = ? AND removed_at IS NULL`, a.id).Scan(&notes, &media); err != nil {
			return err
		}
		_ = srv.db.QueryRowContext(ctx, `SELECT COALESCE(SUM(bytes), 0) FROM library_index WHERE user_id = ?`, a.id).Scan(&index)
		_ = srv.db.QueryRowContext(ctx, `SELECT COALESCE(SUM(declared_bytes), 0) FROM uploads WHERE user_id = ? AND status = 'open'`, a.id).Scan(&reserved)
		notes += index
		// spec 007 (FR-054): what the storage really keeps for the account is the truth, without the old versions waiting for their cleaning
		if stored, storedMedia, ok := srv.storedOf(ctx, a.id); ok {
			notes, media = stored, storedMedia
		}
		if _, err := srv.db.ExecContext(ctx, `UPDATE user SET notes_bytes = ?, media_bytes = ?, reserved_bytes = ?, usage_diff = ?, usage_checked_at = ? WHERE id = ?`,
			notes, media, reserved, a.stored-(notes+media+reserved), now, a.id); err != nil {
			return err
		}
	}
	return nil
}

// Clean deletes the old orphans from the storage, gives up the forgotten uploads and drops the old tombstones.
func (srv *Server) Clean(ctx context.Context) error {
	now := srv.now()
	rows, err := srv.db.QueryContext(ctx, `SELECT object_key FROM orphans WHERE since < ?`, ts(now.Add(-orphanDays*24*time.Hour)))
	if err != nil {
		return err
	}
	var keys []string
	for rows.Next() {
		var key string
		_ = rows.Scan(&key)
		keys = append(keys, key)
	}
	rows.Close()
	for _, key := range keys {
		if err := srv.cfg.Blobs.Delete(ctx, key); err != nil {
			continue
		}
		_, _ = srv.db.ExecContext(ctx, `DELETE FROM orphans WHERE object_key = ?`, key)
	}

	rows, err = srv.db.QueryContext(ctx, `SELECT id, user_id FROM uploads WHERE status = 'open' AND updated_at < ?`, ts(now.Add(-openUploadAge)))
	if err != nil {
		return err
	}
	// read the list to the end first: the database has one connection, so no other query while rows are open
	var ids [][2]string
	for rows.Next() {
		var id, userID string
		_ = rows.Scan(&id, &userID)
		ids = append(ids, [2]string{id, userID})
	}
	rows.Close()
	var forgotten []*upload
	for _, pair := range ids {
		if u, err := findUpload(srv.db, pair[1], pair[0]); err == nil && u != nil {
			forgotten = append(forgotten, u)
		}
	}
	for _, u := range forgotten {
		if _, err := srv.dropUpload(u); err == nil {
			_ = srv.cfg.Blobs.AbortMultipart(ctx, u.Key, u.ID)
		}
	}

	_, err = srv.db.ExecContext(ctx, `DELETE FROM library_items WHERE removed_at IS NOT NULL AND removed_at < ?`, ts(now.Add(-tombstoneDays*24*time.Hour)))
	return err
}

// storedOf lists what the storage keeps for an account (u/<conta>/), media apart, without the orphans waiting for their cleaning.
func (srv *Server) storedOf(ctx context.Context, userID string) (notes, media int64, ok bool) {
	if srv.cfg.Blobs == nil {
		return 0, 0, false
	}
	objects, err := srv.cfg.Blobs.List(ctx, "u/"+userID+"/")
	if err != nil {
		return 0, 0, false
	}
	orphans := map[string]bool{}
	if rows, err := srv.db.QueryContext(ctx, `SELECT object_key FROM orphans WHERE user_id = ?`, userID); err == nil {
		for rows.Next() {
			var key string
			if rows.Scan(&key) == nil {
				orphans[key] = true
			}
		}
		rows.Close()
	}
	for _, object := range objects {
		if orphans[object.Key] {
			continue
		}
		if strings.Contains(object.Key, "/media/") {
			media += object.Size
		} else {
			notes += object.Size
		}
	}
	return notes, media, true
}

// spaceOut is the space of an account as the person and the owner see it (spec 007, FR-050, FR-055): notes, media and the Lixeira apart.
func (srv *Server) spaceOut(q querier, userID string) (map[string]any, error) {
	var notes, media, reserved int64
	var checked sql.NullString
	if err := q.QueryRow(`SELECT notes_bytes, media_bytes, reserved_bytes, usage_checked_at FROM user WHERE id = ?`, userID).Scan(&notes, &media, &reserved, &checked); err != nil {
		return nil, err
	}
	var trashNotes, trashMedia int64
	_ = q.QueryRow(`SELECT COALESCE(SUM(note_bytes), 0), COALESCE(SUM(media_bytes), 0) FROM library_items WHERE user_id = ? AND trashed_at IS NOT NULL AND removed_at IS NULL`, userID).Scan(&trashNotes, &trashMedia)
	notes, media = max(0, notes-trashNotes), max(0, media-trashMedia)
	trash := trashNotes + trashMedia
	used := notes + media + trash + reserved
	var checkedAt any
	if checked.Valid {
		checkedAt = checked.String
	}
	return map[string]any{"notes": notes, "media": media, "trash": trash, "reserved": reserved, "used": used, "limit": spaceLimit, "free": max(0, spaceLimit-used),
		"warnAt": int64(float64(spaceLimit) * spaceWarning), "checkedAt": checkedAt}, nil
}

func (srv *Server) getSpace(w http.ResponseWriter, _ *http.Request, s *Session) {
	out, err := srv.spaceOut(srv.read, s.User.ID)
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// largestItems: the 50 items of the App that take the most, the biggest first, for "Liberar espaço" (FR-053).
func (srv *Server) largestItems(w http.ResponseWriter, _ *http.Request, s *Session) {
	rows, err := srv.read.Query(`SELECT id, name, item_kind, note_type, note_bytes, media_bytes, trashed_at IS NOT NULL, folder_id FROM library_items
		WHERE user_id = ? AND removed_at IS NULL AND item_kind = 'file' AND (note_bytes + media_bytes) > 0 ORDER BY (note_bytes + media_bytes) DESC, name LIMIT 50`, s.User.ID)
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	type item struct {
		id, name, kind        string
		noteType, folder      sql.NullString
		noteBytes, mediaBytes int64
		trashed               bool
	}
	var found []item
	for rows.Next() {
		var it item
		if rows.Scan(&it.id, &it.name, &it.kind, &it.noteType, &it.noteBytes, &it.mediaBytes, &it.trashed, &it.folder) == nil {
			found = append(found, it)
		}
	}
	rows.Close()
	names := map[string][2]string{}
	if folders, err := srv.read.Query(`SELECT id, name, COALESCE(folder_id, '') FROM library_items WHERE user_id = ? AND item_kind = 'folder' AND removed_at IS NULL`, s.User.ID); err == nil {
		for folders.Next() {
			var id, name, parent string
			if folders.Scan(&id, &name, &parent) == nil {
				names[id] = [2]string{name, parent}
			}
		}
		folders.Close()
	}
	pathOf := func(id string) string {
		var parts []string
		for depth := 0; id != "" && depth < 32; depth++ {
			folder, ok := names[id]
			if !ok {
				break
			}
			parts = append([]string{folder[0]}, parts...)
			id = folder[1]
		}
		return strings.Join(append([]string{"Biblioteca"}, parts...), " › ")
	}
	out := []map[string]any{}
	for _, it := range found {
		var noteType any
		if it.noteType.Valid {
			noteType = it.noteType.String
		}
		out = append(out, map[string]any{"id": it.id, "name": it.name, "kind": it.kind, "noteType": noteType, "noteBytes": it.noteBytes, "mediaBytes": it.mediaBytes,
			"trashed": it.trashed, "folderPath": pathOf(it.folder.String)})
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}
