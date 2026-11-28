package server

import (
	"database/sql"
	"encoding/json"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// googleToken opens a session from the Google access token the app already holds (the person is signed in with Google for the
// Drive), so "Usar a estrutura do app" does not ask for a second sign-in. Google itself says who the token belongs to: it must have
// been issued to THIS app (aud/azp), not be expired, and carry a verified e-mail; anything else is refused and nothing is created.
func (srv *Server) googleToken(w http.ResponseWriter, r *http.Request, _ *Session) {
	var body struct {
		AccessToken string `json:"accessToken"`
	}
	if !readJSON(r, &body) || strings.TrimSpace(body.AccessToken) == "" {
		log.Printf("google token: recusado (sem token)")
		fail(w, http.StatusUnauthorized, "google_refused", nil)
		return
	}
	info, ok := srv.tokenInfo(r, body.AccessToken)
	if !ok {
		fail(w, http.StatusUnauthorized, "google_refused", nil)
		return
	}
	claims := &idClaims{Sub: info.Sub, Email: strings.ToLower(strings.TrimSpace(info.Email)), EmailVerified: true, Name: info.Name, Picture: info.Picture}
	var userID string
	var err error
	if claims.Sub != "" {
		userID, err = srv.googleAccount(claims, &googleTokens{})
	} else {
		userID, err = srv.driveAccount(claims)
	}
	if err != nil || srv.startSession(w, r, userID) != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

type tokenInfo struct {
	Aud           string `json:"aud"`
	Azp           string `json:"azp"`
	Sub           string `json:"sub"`
	Email         string `json:"email"`
	EmailVerified any    `json:"email_verified"`
	ExpiresIn     any    `json:"expires_in"`
	// from the Drive, when the token itself does not say whose it is
	Name    string `json:"-"`
	Picture string `json:"-"`
}

func (srv *Server) tokenInfo(r *http.Request, accessToken string) (*tokenInfo, bool) {
	address := srv.cfg.Google.TokenInfoURL + "?access_token=" + url.QueryEscape(accessToken)
	request, err := http.NewRequestWithContext(r.Context(), http.MethodGet, address, nil)
	if err != nil {
		return nil, false
	}
	response, err := srv.cfg.HTTPClient.Do(request)
	if err != nil {
		log.Printf("google token: recusado (Google fora: %v)", err)
		return nil, false
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		log.Printf("google token: recusado (o Google não reconhece o token: %d)", response.StatusCode)
		return nil, false
	}
	var info tokenInfo
	if json.NewDecoder(response.Body).Decode(&info) != nil {
		log.Printf("google token: recusado (resposta do Google ilegível)")
		return nil, false
	}
	mine := false
	for _, client := range append([]string{srv.cfg.Google.ClientID}, srv.cfg.Google.TokenAudiences...) {
		if client != "" && (info.Aud == client || info.Azp == client) {
			mine = true
		}
	}
	if mine && seconds(info.ExpiresIn) > 0 && info.Email == "" {
		srv.driveOwner(r, accessToken, &info)
	}
	if !mine || info.Email == "" || !truthy(info.EmailVerified) || seconds(info.ExpiresIn) <= 0 {
		// o motivo, sem o token nem o e-mail
		log.Printf("google token: recusado (deste app=%v, sub=%v, e-mail=%v, verificado=%v, vence em=%ds)", mine, info.Sub != "", info.Email != "", truthy(info.EmailVerified), seconds(info.ExpiresIn))
		return nil, false
	}
	return &info, true
}

func truthy(v any) bool {
	switch x := v.(type) {
	case bool:
		return x
	case string:
		return x == "true"
	}
	return false
}

func seconds(v any) int {
	switch x := v.(type) {
	case float64:
		return int(x)
	case string:
		n, _ := strconv.Atoi(x)
		return n
	}
	return 0
}

// driveOwner asks the Drive whose account the token is: the app's Drive token has only the Drive permission, no e-mail. The token was
// already proven to be this app's, and a Google account's e-mail is verified by Google.
func (srv *Server) driveOwner(r *http.Request, accessToken string, info *tokenInfo) {
	request, err := http.NewRequestWithContext(r.Context(), http.MethodGet, srv.cfg.Google.DriveAboutURL, nil)
	if err != nil {
		return
	}
	request.Header.Set("Authorization", "Bearer "+accessToken)
	response, err := srv.cfg.HTTPClient.Do(request)
	if err != nil {
		return
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		log.Printf("google token: o Drive não disse de quem é (%d)", response.StatusCode)
		return
	}
	var about struct {
		User struct {
			EmailAddress string `json:"emailAddress"`
			DisplayName  string `json:"displayName"`
			PhotoLink    string `json:"photoLink"`
		} `json:"user"`
	}
	if json.NewDecoder(response.Body).Decode(&about) != nil || about.User.EmailAddress == "" {
		return
	}
	info.Email, info.EmailVerified, info.Name, info.Picture = about.User.EmailAddress, true, about.User.DisplayName, about.User.PhotoLink
}

// driveAccount is the account of a Google e-mail known without Google's id (the Drive token): the account with that e-mail, or a new
// one. The e-mail counts as verified (it came from Google), so a password nobody proved stops working, like in googleAccount.
func (srv *Server) driveAccount(claims *idClaims) (string, error) {
	srv.mu.Lock()
	defer srv.mu.Unlock()
	now := stamp(srv.cfg.Now())
	var id string
	var verified bool
	err := srv.db.QueryRow(`SELECT id, email_verified FROM user WHERE email = ?`, claims.Email).Scan(&id, &verified)
	switch {
	case err == nil:
		if !verified {
			if _, err = srv.db.Exec(`UPDATE user SET password_hash = NULL, login_failures = 0, login_blocked_until = NULL WHERE id = ?`, id); err == nil {
				_, err = srv.db.Exec(`UPDATE devices SET signed_out_at = ? WHERE user_id = ? AND signed_out_at IS NULL`, now, id)
			}
		}
		if err == nil {
			_, err = srv.db.Exec(`UPDATE user SET email_verified = 1, name = COALESCE(name, NULLIF(?, '')), photo_url = COALESCE(photo_url, NULLIF(?, '')), updated_at = ? WHERE id = ?`, claims.Name, claims.Picture, now, id)
		}
	case err == sql.ErrNoRows:
		id = newID()
		_, err = srv.db.Exec(`INSERT INTO user (id, email, email_verified, name, photo_url, created_at, updated_at) VALUES (?, ?, 1, NULLIF(?, ''), NULLIF(?, ''), ?, ?)`, id, claims.Email, claims.Name, claims.Picture, now, now)
	}
	if err == nil {
		srv.accountChanged(id)
	}
	return id, err
}
