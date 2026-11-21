package server

import (
	"database/sql"
	"errors"
	"net/http"
	"strings"
	"time"
)

const (
	sessionCookie = "estudo_session"
	sessionDays   = 180
)

// User is the account as the API reads it.
type User struct {
	ID            string
	Email         string
	EmailVerified bool
	Name          sql.NullString
	PhotoURL      sql.NullString
	Status        string
	AppEnabled    bool
	DeleteAt      *string
	NotesBytes    int64
	MediaBytes    int64
	Reserved      int64
	HasPassword   bool
	HasGoogle     bool
}

// Session is the signed-in account and its device.
type Session struct {
	User     User
	DeviceID string
	Device   string
}

const userColumns = `u.id, u.email, u.email_verified, u.name, u.photo_url, u.status, u.app_enabled, u.delete_at, u.notes_bytes, u.media_bytes, u.reserved_bytes, u.password_hash IS NOT NULL, u.google_sub IS NOT NULL`

func scanUser(row interface{ Scan(...any) error }, extra ...any) (User, error) {
	var user User
	var deleteAt sql.NullString
	var enabled int
	dest := append([]any{&user.ID, &user.Email, &user.EmailVerified, &user.Name, &user.PhotoURL, &user.Status, &enabled, &deleteAt, &user.NotesBytes, &user.MediaBytes, &user.Reserved, &user.HasPassword, &user.HasGoogle}, extra...)
	if err := row.Scan(dest...); err != nil {
		return user, err
	}
	user.AppEnabled = enabled == 1
	if deleteAt.Valid {
		user.DeleteAt = &deleteAt.String
	}
	return user, nil
}

// sessionOf finds the account of the session cookie: only a device that did not sign out and is within its 180 days. A device seen
// again on another day keeps its 180 days from that day.
func (srv *Server) sessionOf(r *http.Request) (*Session, error) {
	cookie, err := r.Cookie(sessionCookie)
	if err != nil || cookie.Value == "" {
		return nil, nil
	}
	now := srv.cfg.Now().UTC()
	var session Session
	var seen string
	user, err := scanUser(srv.db.QueryRow(`SELECT `+userColumns+`, d.id, COALESCE(d.name, ''), d.seen_at FROM devices d JOIN user u ON u.id = d.user_id WHERE d.session_hash = ? AND d.signed_out_at IS NULL AND d.expires_at > ?`, sha256Hex(cookie.Value), stamp(now)), &session.DeviceID, &session.Device, &seen)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	session.User = user
	if last, err := time.Parse(time.RFC3339Nano, seen); err == nil && now.Sub(last) > 24*time.Hour {
		_, _ = srv.db.Exec(`UPDATE devices SET seen_at = ?, expires_at = ? WHERE id = ?`, stamp(now), stamp(now.Add(sessionDays*24*time.Hour)), session.DeviceID)
	}
	return &session, nil
}

// startSession makes a device for the account and gives the browser its cookie; only the hash of the cookie is kept.
func (srv *Server) startSession(w http.ResponseWriter, r *http.Request, userID string) error {
	token := randomToken(32)
	now := srv.cfg.Now().UTC()
	if _, err := srv.db.Exec(`INSERT INTO devices (id, user_id, session_hash, name, created_at, seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, newID(), userID, sha256Hex(token), deviceName(r.UserAgent()), stamp(now), stamp(now), stamp(now.Add(sessionDays*24*time.Hour))); err != nil {
		return err
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: token, Path: "/", MaxAge: sessionDays * 24 * 3600, HttpOnly: true, Secure: srv.cfg.SecureCookies, SameSite: http.SameSiteLaxMode})
	return nil
}

func (srv *Server) logout(w http.ResponseWriter, _ *http.Request, s *Session) {
	if _, err := srv.db.Exec(`UPDATE devices SET signed_out_at = ? WHERE id = ?`, stamp(srv.cfg.Now()), s.DeviceID); err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, Secure: srv.cfg.SecureCookies, SameSite: http.SameSiteLaxMode})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// deviceName gives "Chrome no Linux" from the browser's User-Agent; the person can rename it later.
func deviceName(agent string) string {
	browser := "Navegador"
	for _, known := range []struct{ token, name string }{{"Edg/", "Edge"}, {"OPR/", "Opera"}, {"Firefox/", "Firefox"}, {"Chrome/", "Chrome"}, {"Safari/", "Safari"}} {
		if strings.Contains(agent, known.token) {
			browser = known.name
			break
		}
	}
	system := ""
	for _, known := range []struct{ token, name string }{{"iPhone", "iPhone"}, {"iPad", "iPad"}, {"Android", "Android"}, {"Windows", "Windows"}, {"Mac OS X", "Mac"}, {"Linux", "Linux"}} {
		if strings.Contains(agent, known.token) {
			system = known.name
			break
		}
	}
	if system == "" {
		return browser
	}
	return browser + " no " + system
}
