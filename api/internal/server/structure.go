package server

import (
	"database/sql"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode"
)

const (
	// wrong promo codes in a row; the 10th blocks the account's attempts for 1 hour (contracts/api-conta.md)
	maxCodeFailures = 10
	codeBlock       = time.Hour
)

// normalizeCode keeps letters and digits in upper case: "abcd efgh-jkmn" is ABCDEFGHJKMN.
func normalizeCode(code string) string {
	var b strings.Builder
	for _, r := range strings.ToUpper(code) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func (srv *Server) requireCode() bool {
	value := "1"
	_ = srv.db.QueryRow(`SELECT value FROM app_settings WHERE key = 'require_code'`).Scan(&value)
	return value == "1"
}

// useCode frees the account with a promo code and turns "Usar a estrutura do app" on. Refusals, in this order: blocked by attempts,
// does not exist, canceled, expired, used up; each one but the block counts towards the block.
func (srv *Server) useCode(w http.ResponseWriter, r *http.Request, s *Session) {
	var body struct {
		Code string `json:"code"`
	}
	if !readJSON(r, &body) {
		fail(w, http.StatusBadRequest, "invalid_body", nil)
		return
	}
	code := normalizeCode(body.Code)
	srv.mu.Lock()
	defer srv.mu.Unlock()
	now := srv.cfg.Now().UTC()
	var status string
	var failures int
	var blocked sql.NullString
	if err := srv.db.QueryRow(`SELECT status, code_failures, code_blocked_until FROM user WHERE id = ?`, s.User.ID).Scan(&status, &failures, &blocked); err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	if status == "enabled" {
		if _, err := srv.db.Exec(`UPDATE user SET app_enabled = 1, updated_at = ? WHERE id = ?`, stamp(now), s.User.ID); err != nil {
			fail(w, http.StatusInternalServerError, "internal_error", nil)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"status": "enabled", "alreadyEnabled": true})
		return
	}
	if blocked.Valid {
		if until, err := time.Parse(time.RFC3339Nano, blocked.String); err == nil && until.After(now) {
			fail(w, http.StatusTooManyRequests, "too_many_attempts", map[string]any{"retryAfter": blocked.String})
			return
		}
	}
	refuse := func(httpStatus int, errorCode string, data map[string]any) {
		failures++
		if failures >= maxCodeFailures {
			_, _ = srv.db.Exec(`UPDATE user SET code_failures = 0, code_blocked_until = ? WHERE id = ?`, stamp(now.Add(codeBlock)), s.User.ID)
		} else {
			_, _ = srv.db.Exec(`UPDATE user SET code_failures = ? WHERE id = ?`, failures, s.User.ID)
		}
		fail(w, httpStatus, errorCode, data)
	}
	var codeID, validUntil string
	var maxUses, uses int
	var canceled sql.NullString
	err := srv.db.QueryRow(`SELECT id, max_uses, uses, valid_until, canceled_at FROM promo_codes WHERE code = ?`, code).Scan(&codeID, &maxUses, &uses, &validUntil, &canceled)
	switch {
	case errors.Is(err, sql.ErrNoRows) || code == "":
		refuse(http.StatusNotFound, "code_not_found", nil)
		return
	case err != nil:
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	case canceled.Valid:
		refuse(http.StatusGone, "code_canceled", nil)
		return
	case expired(validUntil, now):
		refuse(http.StatusGone, "code_expired", map[string]any{"expiredAt": validUntil})
		return
	case uses >= maxUses:
		refuse(http.StatusConflict, "code_used_up", nil)
		return
	}
	tx, err := srv.db.Begin()
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	defer tx.Rollback()
	result, err := tx.Exec(`UPDATE promo_codes SET uses = uses + 1 WHERE id = ? AND uses < max_uses`, codeID)
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	if changed, _ := result.RowsAffected(); changed != 1 {
		tx.Rollback()
		refuse(http.StatusConflict, "code_used_up", nil)
		return
	}
	if _, err := tx.Exec(`INSERT INTO promo_code_uses (user_id, promo_code_id, used_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET promo_code_id = excluded.promo_code_id, used_at = excluded.used_at`, s.User.ID, codeID, stamp(now)); err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	if _, err := tx.Exec(`UPDATE user SET status = 'enabled', app_enabled = 1, enabled_at = ?, code_failures = 0, code_blocked_until = NULL, updated_at = ? WHERE id = ?`, stamp(now), stamp(now), s.User.ID); err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	if err := tx.Commit(); err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "enabled"})
}

func expired(validUntil string, now time.Time) bool {
	until, err := time.Parse(time.RFC3339Nano, validUntil)
	return err != nil || !until.After(now)
}

// setStructure turns "Usar a estrutura do app" on or off. On needs a freed account, unless the owner turned the code rule off; off
// deletes nothing.
func (srv *Server) setStructure(w http.ResponseWriter, r *http.Request, s *Session) {
	var body struct {
		On *bool `json:"on"`
	}
	if !readJSON(r, &body) || body.On == nil {
		fail(w, http.StatusBadRequest, "invalid_body", nil)
		return
	}
	now := stamp(srv.cfg.Now())
	query := `UPDATE user SET app_enabled = ?1, updated_at = ?2 WHERE id = ?3`
	if *body.On && s.User.Status != "enabled" {
		// the owner (admin) never needs an invite code
		if srv.requireCode() && !srv.adminOf(s.User) {
			fail(w, http.StatusForbidden, "code_required", nil)
			return
		}
		query = `UPDATE user SET app_enabled = ?1, status = 'enabled', enabled_at = ?2, updated_at = ?2 WHERE id = ?3`
	}
	on := 0
	if *body.On {
		on = 1
	}
	if _, err := srv.db.Exec(query, on, now, s.User.ID); err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"appEnabled": *body.On})
}
