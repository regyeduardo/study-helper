package server

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
)

// Spec 005 (contracts/api-hierarquia.md): the hierarchy of before is kept as a copy before the migration writes anything (FR-014),
// and the migration ends only when the map has the counts the app sent (FR-016).

const maxBackupBytes = 4 << 20

// hierarchyBackup keeps the copy of the hierarchy of before. Before hierarchy_at, asking again gives back the copy already kept.
func (srv *Server) hierarchyBackup(w http.ResponseWriter, r *http.Request, s *Session) {
	raw, ok := readBody(r, maxBackupBytes)
	if !ok {
		fail(w, http.StatusRequestEntityTooLarge, "too_large", nil)
		return
	}
	var body struct {
		Snapshot *struct {
			Folders []json.RawMessage `json:"folders"`
			Files   []json.RawMessage `json:"files"`
		} `json:"snapshot"`
	}
	if json.Unmarshal(raw, &body) != nil || body.Snapshot == nil || body.Snapshot.Folders == nil || body.Snapshot.Files == nil {
		fail(w, http.StatusBadRequest, "invalid_body", nil)
		return
	}
	// the copy keeps the hierarchy, never the text of a note (as the map)
	for _, list := range [][]json.RawMessage{body.Snapshot.Folders, body.Snapshot.Files} {
		for i, item := range list {
			clean, err := cleanMeta(item)
			if err != nil {
				fail(w, http.StatusBadRequest, "invalid_body", nil)
				return
			}
			list[i] = json.RawMessage(clean)
		}
	}
	snapshot, err := json.Marshal(map[string]any{"folders": body.Snapshot.Folders, "files": body.Snapshot.Files})
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	tx, err := srv.db.Begin()
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	defer tx.Rollback()
	var id string
	var folders, files int
	err = tx.QueryRow(`SELECT b.id, b.folders, b.files FROM hierarchy_backups b JOIN user u ON u.id = b.user_id
		WHERE b.user_id = ? AND u.hierarchy_at IS NULL ORDER BY b.created_at DESC LIMIT 1`, s.User.ID).Scan(&id, &folders, &files)
	if err == nil {
		writeJSON(w, http.StatusOK, map[string]any{"id": id, "folders": folders, "files": files})
		return
	}
	if !errors.Is(err, sql.ErrNoRows) {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	id, folders, files = newID(), len(body.Snapshot.Folders), len(body.Snapshot.Files)
	if _, err := tx.Exec(`INSERT INTO hierarchy_backups (user_id, id, snapshot, folders, files, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
		s.User.ID, id, string(snapshot), folders, files, stamp(srv.now())); err != nil || tx.Commit() != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": id, "folders": folders, "files": files})
}

// hierarchyDone marks the migration as done when the live rows of the map (not deleted for good) match the counts sent. Asking
// again after it is done gives back the same hierarchyAt.
func (srv *Server) hierarchyDone(w http.ResponseWriter, r *http.Request, s *Session) {
	var body struct {
		BackupID string `json:"backupId"`
		Folders  int64  `json:"folders"`
		Files    int64  `json:"files"`
	}
	if !readJSON(r, &body) || body.BackupID == "" {
		fail(w, http.StatusBadRequest, "invalid_body", nil)
		return
	}
	tx, err := srv.db.Begin()
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	defer tx.Rollback()
	var done sql.NullString
	if err := tx.QueryRow(`SELECT hierarchy_at FROM user WHERE id = ?`, s.User.ID).Scan(&done); err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	if done.Valid {
		writeJSON(w, http.StatusOK, map[string]any{"hierarchyAt": done.String})
		return
	}
	var backups int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM hierarchy_backups WHERE user_id = ? AND id = ?`, s.User.ID, body.BackupID).Scan(&backups); err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	if backups == 0 {
		fail(w, http.StatusNotFound, "backup_not_found", nil)
		return
	}
	var folders, files int64
	if err := tx.QueryRow(`SELECT COALESCE(SUM(item_kind = 'folder'), 0), COALESCE(SUM(item_kind = 'file'), 0) FROM library_items
		WHERE user_id = ? AND removed_at IS NULL`, s.User.ID).Scan(&folders, &files); err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	if folders != body.Folders || files != body.Files {
		fail(w, http.StatusConflict, "count_mismatch", map[string]any{"folders": folders, "files": files})
		return
	}
	at := stamp(srv.now())
	if _, err := tx.Exec(`UPDATE user SET hierarchy_at = ?, updated_at = ? WHERE id = ?`, at, at, s.User.ID); err != nil || tx.Commit() != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"hierarchyAt": at})
}
