package server

import (
	"net/http"
	"strings"
	"unicode/utf8"
)

const maxDeviceName = 60

// devices lists the account's devices that are still signed in, the most recently seen first, marking this one.
func (srv *Server) devices(w http.ResponseWriter, _ *http.Request, s *Session) {
	rows, err := srv.db.Query(`SELECT id, COALESCE(name, ''), seen_at FROM devices WHERE user_id = ? AND signed_out_at IS NULL AND expires_at > ? ORDER BY seen_at DESC`, s.User.ID, stamp(srv.cfg.Now()))
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	defer rows.Close()
	list := []map[string]any{}
	for rows.Next() {
		var id, name, seen string
		if err := rows.Scan(&id, &name, &seen); err != nil {
			fail(w, http.StatusInternalServerError, "internal_error", nil)
			return
		}
		list = append(list, map[string]any{"id": id, "name": name, "seenAt": seen, "current": id == s.DeviceID})
	}
	writeJSON(w, http.StatusOK, map[string]any{"devices": list})
}

func (srv *Server) renameDevice(w http.ResponseWriter, r *http.Request, s *Session) {
	var body struct {
		Name string `json:"name"`
	}
	if !readJSON(r, &body) {
		fail(w, http.StatusBadRequest, "invalid_body", nil)
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" || utf8.RuneCountInString(name) > maxDeviceName {
		fail(w, http.StatusBadRequest, "invalid_name", map[string]any{"maxLength": maxDeviceName})
		return
	}
	srv.changeDevice(w, r, s, `UPDATE devices SET name = ? WHERE id = ? AND user_id = ? AND signed_out_at IS NULL`, name)
}

// signOutDevice ends that device's session; signing out this very device also drops its cookie.
func (srv *Server) signOutDevice(w http.ResponseWriter, r *http.Request, s *Session) {
	if r.PathValue("id") == s.DeviceID {
		http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, Secure: srv.cfg.SecureCookies, SameSite: http.SameSiteLaxMode})
	}
	srv.changeDevice(w, r, s, `UPDATE devices SET signed_out_at = ? WHERE id = ? AND user_id = ? AND signed_out_at IS NULL`, stamp(srv.cfg.Now()))
}

// changeDevice runs a change on one of the account's own devices; a device of another account is a device that does not exist.
func (srv *Server) changeDevice(w http.ResponseWriter, r *http.Request, s *Session, query string, value string) {
	result, err := srv.db.Exec(query, value, r.PathValue("id"), s.User.ID)
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	if changed, _ := result.RowsAffected(); changed == 0 {
		fail(w, http.StatusNotFound, "not_found", nil)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
