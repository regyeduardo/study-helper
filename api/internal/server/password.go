package server

import (
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/mail"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/crypto/argon2"
)

const (
	maxLoginFailures = 10
	loginBlock       = 15 * time.Minute
	minPassword      = 8
	maxPassword      = 256
)

// argon2id with the OWASP minimum (19 MiB, 2 passes, 1 lane).
const (
	argonMemory  = 19 * 1024
	argonTime    = 2
	argonThreads = 1
	argonKeyLen  = 32
)

func hashPassword(password string) string {
	salt := []byte(randomToken(16))
	key := argon2.IDKey([]byte(password), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	return fmt.Sprintf("$argon2id$v=19$m=%d,t=%d,p=%d$%s$%s", argonMemory, argonTime, argonThreads, base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key))
}

func checkPassword(password, encoded string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false
	}
	var memory, passes uint32
	var threads uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &memory, &passes, &threads); err != nil {
		return false
	}
	salt, err1 := base64.RawStdEncoding.DecodeString(parts[4])
	want, err2 := base64.RawStdEncoding.DecodeString(parts[5])
	if err1 != nil || err2 != nil {
		return false
	}
	got := argon2.IDKey([]byte(password), salt, passes, memory, threads, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1
}

func normalizeEmail(email string) (string, bool) {
	email = strings.ToLower(strings.TrimSpace(email))
	address, err := mail.ParseAddress(email)
	if err != nil || address.Address != email || len(email) > 254 {
		return "", false
	}
	return email, true
}

type credentials struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	Name     string `json:"name"`
}

// register makes an account with e-mail and password and signs it in (FR-001).
func (srv *Server) register(w http.ResponseWriter, r *http.Request, _ *Session) {
	var body credentials
	if !readJSON(r, &body) {
		fail(w, http.StatusBadRequest, "invalid_body", nil)
		return
	}
	email, ok := normalizeEmail(body.Email)
	if !ok {
		fail(w, http.StatusBadRequest, "invalid_email", nil)
		return
	}
	length := utf8.RuneCountInString(body.Password)
	if length < minPassword || length > maxPassword {
		fail(w, http.StatusBadRequest, "weak_password", map[string]any{"minLength": minPassword})
		return
	}
	now := stamp(srv.cfg.Now())
	id := newID()
	name := strings.TrimSpace(body.Name)
	_, err := srv.db.Exec(`INSERT INTO user (id, email, name, password_hash, created_at, updated_at) VALUES (?, ?, NULLIF(?, ''), ?, ?, ?)`, id, email, name, hashPassword(body.Password), now, now)
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			fail(w, http.StatusConflict, "email_taken", nil)
			return
		}
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	if err := srv.startSession(w, r, id); err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"user": map[string]any{"id": id, "email": email}})
}

// login signs in with e-mail and password. A wrong e-mail and a wrong password get the same answer; 10 wrong passwords in a row block
// the sign-in of that e-mail for 15 minutes.
func (srv *Server) login(w http.ResponseWriter, r *http.Request, _ *Session) {
	var body credentials
	if !readJSON(r, &body) {
		fail(w, http.StatusBadRequest, "invalid_body", nil)
		return
	}
	email, ok := normalizeEmail(body.Email)
	if !ok {
		fail(w, http.StatusUnauthorized, "wrong_credentials", nil)
		return
	}
	now := srv.cfg.Now().UTC()
	var id string
	var hash, blocked sql.NullString
	var failures int
	err := srv.db.QueryRow(`SELECT id, password_hash, login_failures, login_blocked_until FROM user WHERE email = ?`, email).Scan(&id, &hash, &failures, &blocked)
	if errors.Is(err, sql.ErrNoRows) {
		// the same work as a real check, so the answer time does not tell whether the e-mail exists
		checkPassword(body.Password, "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$c2FsdHNhbHRzYWx0c2FsdHNhbHRzYWx0c2FsdHNhbHQ")
		fail(w, http.StatusUnauthorized, "wrong_credentials", nil)
		return
	}
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	if blocked.Valid {
		if until, err := time.Parse(time.RFC3339Nano, blocked.String); err == nil && until.After(now) {
			fail(w, http.StatusTooManyRequests, "too_many_attempts", map[string]any{"retryAfter": blocked.String})
			return
		}
	}
	if !hash.Valid || !checkPassword(body.Password, hash.String) {
		failures++
		if failures >= maxLoginFailures {
			_, _ = srv.db.Exec(`UPDATE user SET login_failures = 0, login_blocked_until = ? WHERE id = ?`, stamp(now.Add(loginBlock)), id)
		} else {
			_, _ = srv.db.Exec(`UPDATE user SET login_failures = ? WHERE id = ?`, failures, id)
		}
		fail(w, http.StatusUnauthorized, "wrong_credentials", nil)
		return
	}
	_, _ = srv.db.Exec(`UPDATE user SET login_failures = 0, login_blocked_until = NULL WHERE id = ?`, id)
	if err := srv.startSession(w, r, id); err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"user": map[string]any{"id": id, "email": email}})
}
