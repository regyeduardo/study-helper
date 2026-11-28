package server

import (
	"crypto/rand"
	"database/sql"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	// a new code: 1 person, 30 days (FR-005)
	defaultCodeUses = 1
	defaultCodeDays = 30
	// revoking deletes the account's data 30 days later (FR-006)
	revokeDays = 30
	// no I, O, 0 nor 1, which are mistaken for each other when typed
	codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	codeLength   = 12
	maxMadeFor   = 200
)

// adminOnly is a route of the Administração. For anyone who is not the admin, signed in or not, it answers like a route that does not
// exist and does nothing (SC-013); for the admin, the common rules apply.
func (srv *Server) adminOnly(handle handlerFunc) http.Handler {
	inner := srv.rules(signedIn, false, handle)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		session, err := srv.authenticate(w, r)
		if err != nil {
			fail(w, http.StatusInternalServerError, "internal_error", nil)
			return
		}
		if session == nil || !srv.adminOf(session.User) {
			fail(w, http.StatusNotFound, "not_found", nil)
			return
		}
		inner.ServeHTTP(w, r)
	})
}

func newCode() string {
	buffer := make([]byte, codeLength)
	_, _ = rand.Read(buffer)
	for i, b := range buffer {
		buffer[i] = codeAlphabet[int(b)%len(codeAlphabet)]
	}
	return string(buffer)
}

func codeStatus(maxUses, uses int, validUntil string, canceled sql.NullString, now time.Time) string {
	switch {
	case canceled.Valid:
		return "canceled"
	case expired(validUntil, now):
		return "expired"
	case uses >= maxUses:
		return "used-up"
	}
	return "active"
}

// adminCodes lists the codes, the newest first, with who used each one.
func (srv *Server) adminCodes(w http.ResponseWriter, _ *http.Request, _ *Session) {
	now := srv.cfg.Now().UTC()
	rows, err := srv.db.Query(`SELECT id, code, max_uses, uses, valid_until, COALESCE(made_for, ''), canceled_at, created_at FROM promo_codes ORDER BY created_at DESC`)
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	codes := []map[string]any{}
	byID := map[string]map[string]any{}
	for rows.Next() {
		var id, code, validUntil, madeFor, created string
		var maxUses, uses int
		var canceled sql.NullString
		if err := rows.Scan(&id, &code, &maxUses, &uses, &validUntil, &madeFor, &canceled, &created); err != nil {
			rows.Close()
			fail(w, http.StatusInternalServerError, "internal_error", nil)
			return
		}
		row := map[string]any{"id": id, "code": code, "maxUses": maxUses, "uses": uses, "validUntil": validUntil, "madeFor": madeFor, "status": codeStatus(maxUses, uses, validUntil, canceled, now), "createdAt": created, "accounts": []map[string]any{}}
		codes = append(codes, row)
		byID[id] = row
	}
	rows.Close()
	uses, err := srv.db.Query(`SELECT p.promo_code_id, u.id, COALESCE(u.name, ''), u.email, p.used_at FROM promo_code_uses p JOIN user u ON u.id = p.user_id ORDER BY p.used_at`)
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	defer uses.Close()
	for uses.Next() {
		var codeID, id, name, email, usedAt string
		if err := uses.Scan(&codeID, &id, &name, &email, &usedAt); err != nil {
			fail(w, http.StatusInternalServerError, "internal_error", nil)
			return
		}
		if row := byID[codeID]; row != nil {
			row["accounts"] = append(row["accounts"].([]map[string]any), map[string]any{"id": id, "name": name, "email": email, "usedAt": usedAt})
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"codes": codes})
}

// adminCreateCode makes a code; by default for 1 person and valid for 30 days.
func (srv *Server) adminCreateCode(w http.ResponseWriter, r *http.Request, _ *Session) {
	var body struct {
		MaxUses    *int   `json:"maxUses"`
		ValidUntil string `json:"validUntil"`
		MadeFor    string `json:"madeFor"`
	}
	if !readJSON(r, &body) {
		fail(w, http.StatusBadRequest, "invalid_body", nil)
		return
	}
	now := srv.cfg.Now().UTC()
	maxUses := defaultCodeUses
	if body.MaxUses != nil {
		maxUses = *body.MaxUses
	}
	if maxUses < 1 {
		fail(w, http.StatusBadRequest, "invalid_max_uses", nil)
		return
	}
	validUntil := now.Add(defaultCodeDays * 24 * time.Hour)
	if body.ValidUntil != "" {
		parsed, err := time.Parse(time.RFC3339Nano, body.ValidUntil)
		if err != nil {
			// a date alone counts until the end of that day
			parsed, err = time.Parse(time.DateOnly, body.ValidUntil)
			parsed = parsed.Add(24*time.Hour - time.Second)
		}
		if err != nil || !parsed.After(now) {
			fail(w, http.StatusBadRequest, "invalid_valid_until", nil)
			return
		}
		validUntil = parsed.UTC()
	}
	madeFor := strings.TrimSpace(body.MadeFor)
	if utf8.RuneCountInString(madeFor) > maxMadeFor {
		fail(w, http.StatusBadRequest, "invalid_made_for", map[string]any{"maxLength": maxMadeFor})
		return
	}
	id := newID()
	var code string
	for attempt := 0; ; attempt++ {
		code = newCode()
		_, err := srv.db.Exec(`INSERT INTO promo_codes (id, code, max_uses, valid_until, made_for, created_at) VALUES (?, ?, ?, ?, NULLIF(?, ''), ?)`, id, code, maxUses, stamp(validUntil), madeFor, stamp(now))
		if err == nil {
			break
		}
		if !strings.Contains(err.Error(), "UNIQUE") || attempt == 4 {
			fail(w, http.StatusInternalServerError, "internal_error", nil)
			return
		}
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": id, "code": code, "maxUses": maxUses, "uses": 0, "validUntil": stamp(validUntil), "madeFor": madeFor, "status": "active", "createdAt": stamp(now), "accounts": []any{}})
}

// adminCancelCode stops new uses; accounts already freed by it stay freed.
func (srv *Server) adminCancelCode(w http.ResponseWriter, r *http.Request, _ *Session) {
	result, err := srv.db.Exec(`UPDATE promo_codes SET canceled_at = COALESCE(canceled_at, ?) WHERE id = ?`, stamp(srv.cfg.Now()), r.PathValue("id"))
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

// adminAccounts lists the accounts, the newest first, with the code each one used, the space and when it was last seen.
func (srv *Server) adminAccounts(w http.ResponseWriter, _ *http.Request, _ *Session) {
	rows, err := srv.db.Query(`SELECT u.id, COALESCE(u.name, ''), u.email, u.status, u.app_enabled, u.enabled_at, u.delete_at, u.notes_bytes, u.media_bytes, c.code,
		(SELECT MAX(d.seen_at) FROM devices d WHERE d.user_id = u.id)
		FROM user u LEFT JOIN promo_code_uses p ON p.user_id = u.id LEFT JOIN promo_codes c ON c.id = p.promo_code_id
		ORDER BY u.created_at DESC`)
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	defer rows.Close()
	accounts := []map[string]any{}
	for rows.Next() {
		var id, name, email, status string
		var appEnabled int
		var enabledAt, deleteAt, code, seenAt sql.NullString
		var notes, media int64
		if err := rows.Scan(&id, &name, &email, &status, &appEnabled, &enabledAt, &deleteAt, &notes, &media, &code, &seenAt); err != nil {
			fail(w, http.StatusInternalServerError, "internal_error", nil)
			return
		}
		accounts = append(accounts, map[string]any{
			"id": id, "name": name, "email": email, "status": status, "appEnabled": appEnabled == 1,
			"enabledAt": nullable(enabledAt.String, enabledAt.Valid), "deleteAt": nullable(deleteAt.String, deleteAt.Valid),
			"code": nullable(code.String, code.Valid), "seenAt": nullable(seenAt.String, seenAt.Valid),
			"space": srv.adminSpace(id, notes, media),
			"jobs":  srv.adminJobs(id),
			"ai":    srv.adminAIUse(id),
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"accounts": accounts})
}

// adminJobs: the account's jobs of generating now, and how many ended in the last 30 days (FR-055). Read by the read pool: the
// accounts' rows are open on the writing connection.
func (srv *Server) adminJobs(userID string) map[string]any {
	since := ts(srv.now().Add(-30 * 24 * time.Hour))
	var running, queued, done, failed int
	_ = srv.read.QueryRow(`SELECT COALESCE(SUM(state = 'running'), 0), COALESCE(SUM(state = 'queued'), 0),
		COALESCE(SUM(state = 'done' AND finished_at >= ?), 0), COALESCE(SUM(state IN ('failed', 'dismissed') AND finished_at >= ?), 0)
		FROM jobs WHERE user_id = ?`, since, since, userID).Scan(&running, &queued, &done, &failed)
	return map[string]any{"running": running, "queued": queued, "done": done, "failed": failed}
}

// adminAIUse: the account's use of the app's AI in the last 30 days (FR-055).
func (srv *Server) adminAIUse(userID string) map[string]any {
	since := srv.now().UTC().Add(-30 * 24 * time.Hour).Format("2006-01-02")
	var calls, input, output int64
	_ = srv.read.QueryRow(`SELECT COALESCE(SUM(calls), 0), COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0) FROM ai_usage WHERE user_id = ? AND day >= ?`, userID, since).Scan(&calls, &input, &output)
	return map[string]any{"calls": calls, "inputTokens": input, "outputTokens": output}
}

// adminRevoke takes the access away: the account reaches only its "me" and its data is deleted 30 days later (FR-006).
func (srv *Server) adminRevoke(w http.ResponseWriter, r *http.Request, s *Session) {
	id := r.PathValue("id")
	if id == s.User.ID {
		fail(w, http.StatusConflict, "cannot_revoke_self", nil)
		return
	}
	now := srv.cfg.Now().UTC()
	deleteAt := stamp(now.Add(revokeDays * 24 * time.Hour))
	result, err := srv.db.Exec(`UPDATE user SET status = 'revoked', app_enabled = 0, revoked_at = ?, delete_at = ?, updated_at = ? WHERE id = ?`, stamp(now), deleteAt, stamp(now), id)
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	if changed, _ := result.RowsAffected(); changed == 0 {
		fail(w, http.StatusNotFound, "not_found", nil)
		return
	}
	srv.accountChanged(id)
	// every open device of that account hears it now (live channel, entrega 4)
	srv.notifyAccess(id, deleteAt)
	// spec 007: the jobs of the account stop, with the reason
	srv.failJobsOf(id, "access_revoked", "O acesso desta conta foi retirado.")
	writeJSON(w, http.StatusOK, map[string]any{"deleteAt": deleteAt})
}

func (srv *Server) adminSettings(w http.ResponseWriter, _ *http.Request, _ *Session) {
	writeJSON(w, http.StatusOK, map[string]any{"requireCode": srv.requireCode()})
}

// adminSetSettings turns the code rule on or off; turning it off does not change the accounts already freed (FR-007).
func (srv *Server) adminSetSettings(w http.ResponseWriter, r *http.Request, _ *Session) {
	var body struct {
		RequireCode *bool `json:"requireCode"`
	}
	if !readJSON(r, &body) || body.RequireCode == nil {
		fail(w, http.StatusBadRequest, "invalid_body", nil)
		return
	}
	value := "0"
	if *body.RequireCode {
		value = "1"
	}
	if _, err := srv.db.Exec(`INSERT INTO app_settings (key, value) VALUES ('require_code', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, value); err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"requireCode": *body.RequireCode})
}

// adminSpace is the space of an account as the person sees it (spec 007, FR-055); the counts of the list when it cannot be read.
func (srv *Server) adminSpace(id string, notes, media int64) map[string]any {
	if out, err := srv.spaceOut(srv.read, id); err == nil {
		return out
	}
	return map[string]any{"notes": notes, "media": media, "limit": spaceLimit}
}
