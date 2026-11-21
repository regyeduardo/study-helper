package server

import (
	"context"
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
