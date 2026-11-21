package server

import (
	"crypto"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	loginCookie = "estudo_login"
	loginWindow = 10 * time.Minute
	googleScope = "openid email profile https://www.googleapis.com/auth/drive.appdata"
)

type loginState struct {
	State    string `json:"s"`
	Verifier string `json:"v"`
	ReturnTo string `json:"r"`
	Expires  int64  `json:"e"`
}

// safeReturn accepts only a path of the app itself ("/biblioteca"), never another site ("//evil", "https://evil").
func safeReturn(path string) string {
	if !strings.HasPrefix(path, "/") || strings.HasPrefix(path, "//") || strings.ContainsAny(path, "\\\r\n") {
		return "/"
	}
	return path
}

func (srv *Server) sign(data []byte) string {
	mac := hmac.New(sha256.New, srv.cfg.TokenKey)
	mac.Write([]byte("estudo-login:"))
	mac.Write(data)
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (srv *Server) redirectURL() string {
	return strings.TrimRight(srv.cfg.PublicURL, "/") + "/v1/auth/google/callback"
}

// googleStart sends the person to Google, with state and PKCE kept in a short signed cookie (contracts, FR-008).
func (srv *Server) googleStart(w http.ResponseWriter, r *http.Request, _ *Session) {
	state := loginState{State: randomToken(24), Verifier: randomToken(48), ReturnTo: safeReturn(r.URL.Query().Get("return_to")), Expires: srv.cfg.Now().Add(loginWindow).Unix()}
	raw, _ := json.Marshal(state)
	value := base64.RawURLEncoding.EncodeToString(raw) + "." + srv.sign(raw)
	http.SetCookie(w, &http.Cookie{Name: loginCookie, Value: value, Path: "/v1/auth/google", MaxAge: int(loginWindow.Seconds()), HttpOnly: true, Secure: srv.cfg.SecureCookies, SameSite: http.SameSiteLaxMode})
	challenge := sha256.Sum256([]byte(state.Verifier))
	query := url.Values{
		"client_id": {srv.cfg.Google.ClientID}, "redirect_uri": {srv.redirectURL()}, "response_type": {"code"}, "scope": {googleScope},
		"access_type": {"offline"}, "include_granted_scopes": {"true"}, "prompt": {"consent"}, "state": {state.State},
		"code_challenge": {base64.RawURLEncoding.EncodeToString(challenge[:])}, "code_challenge_method": {"S256"},
	}
	http.Redirect(w, r, srv.cfg.Google.AuthURL+"?"+query.Encode(), http.StatusFound)
}

func (srv *Server) readLoginState(r *http.Request) (*loginState, bool) {
	cookie, err := r.Cookie(loginCookie)
	if err != nil {
		return nil, false
	}
	body, mac, found := strings.Cut(cookie.Value, ".")
	raw, err := base64.RawURLEncoding.DecodeString(body)
	if !found || err != nil || !hmac.Equal([]byte(mac), []byte(srv.sign(raw))) {
		return nil, false
	}
	var state loginState
	if json.Unmarshal(raw, &state) != nil || srv.cfg.Now().Unix() > state.Expires {
		return nil, false
	}
	return &state, true
}

// googleCallback checks state, exchanges the code, checks the id_token, finds or makes the account by Google's `sub`, keeps the
// encrypted refresh token, starts the session and goes back to the app. Failures go back with ?login=refused|expired|failed.
func (srv *Server) googleCallback(w http.ResponseWriter, r *http.Request, _ *Session) {
	back := func(path, outcome string) {
		http.SetCookie(w, &http.Cookie{Name: loginCookie, Value: "", Path: "/v1/auth/google", MaxAge: -1, HttpOnly: true, Secure: srv.cfg.SecureCookies, SameSite: http.SameSiteLaxMode})
		target := strings.TrimRight(srv.cfg.AppOrigin, "/") + path
		if outcome != "" {
			separator := "?"
			if strings.Contains(path, "?") {
				separator = "&"
			}
			target += separator + "login=" + outcome
		}
		http.Redirect(w, r, target, http.StatusFound)
	}
	state, ok := srv.readLoginState(r)
	query := r.URL.Query()
	if !ok || query.Get("state") == "" || !hmac.Equal([]byte(query.Get("state")), []byte(state.State)) {
		back("/", "expired")
		return
	}
	if query.Get("error") != "" {
		back(state.ReturnTo, "refused")
		return
	}
	tokens, err := srv.exchangeCode(r, query.Get("code"), state.Verifier)
	if err != nil {
		back(state.ReturnTo, "failed")
		return
	}
	claims, err := srv.verifyIDToken(r, tokens.IDToken)
	if err != nil {
		back(state.ReturnTo, "failed")
		return
	}
	userID, err := srv.googleAccount(claims, tokens)
	if err != nil || srv.startSession(w, r, userID) != nil {
		back(state.ReturnTo, "failed")
		return
	}
	back(state.ReturnTo, "")
}

type googleTokens struct {
	IDToken      string `json:"id_token"`
	RefreshToken string `json:"refresh_token"`
	Scope        string `json:"scope"`
}

func (srv *Server) exchangeCode(r *http.Request, code, verifier string) (*googleTokens, error) {
	form := url.Values{"code": {code}, "client_id": {srv.cfg.Google.ClientID}, "client_secret": {srv.cfg.Google.ClientSecret}, "redirect_uri": {srv.redirectURL()}, "grant_type": {"authorization_code"}, "code_verifier": {verifier}}
	request, err := http.NewRequestWithContext(r.Context(), http.MethodPost, srv.cfg.Google.TokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := srv.cfg.HTTPClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("google token: %d", response.StatusCode)
	}
	var tokens googleTokens
	if err := json.NewDecoder(response.Body).Decode(&tokens); err != nil || tokens.IDToken == "" {
		return nil, errors.New("google token: no id_token")
	}
	return &tokens, nil
}

type idClaims struct {
	Sub           string `json:"sub"`
	Email         string `json:"email"`
	EmailVerified any    `json:"email_verified"`
	Name          string `json:"name"`
	Picture       string `json:"picture"`
	Iss           string `json:"iss"`
	Aud           any    `json:"aud"`
	Exp           int64  `json:"exp"`
}

// verifyIDToken checks the RS256 signature against Google's keys, the issuer, the audience (this app), the expiry and a verified e-mail.
func (srv *Server) verifyIDToken(r *http.Request, token string) (*idClaims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, errors.New("id_token: malformed")
	}
	var header struct {
		Alg string `json:"alg"`
		Kid string `json:"kid"`
	}
	rawHeader, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || json.Unmarshal(rawHeader, &header) != nil || header.Alg != "RS256" {
		return nil, errors.New("id_token: header")
	}
	key, err := srv.keys.get(r, srv.cfg.HTTPClient, srv.cfg.Google.JWKSURL, header.Kid)
	if err != nil {
		return nil, err
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if err := rsa.VerifyPKCS1v15(key, crypto.SHA256, digest[:], signature); err != nil {
		return nil, errors.New("id_token: signature")
	}
	rawClaims, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, err
	}
	var claims idClaims
	if err := json.Unmarshal(rawClaims, &claims); err != nil {
		return nil, err
	}
	issuerOK := false
	for _, issuer := range srv.cfg.Google.Issuers {
		issuerOK = issuerOK || claims.Iss == issuer
	}
	audienceOK := claims.Aud == srv.cfg.Google.ClientID
	if list, isList := claims.Aud.([]any); isList {
		for _, item := range list {
			audienceOK = audienceOK || item == srv.cfg.Google.ClientID
		}
	}
	verified := claims.EmailVerified == true || claims.EmailVerified == "true"
	switch {
	case !issuerOK:
		return nil, errors.New("id_token: issuer")
	case !audienceOK:
		return nil, errors.New("id_token: audience")
	case srv.cfg.Now().Unix() > claims.Exp+60:
		return nil, errors.New("id_token: expired")
	case claims.Sub == "" || !verified:
		return nil, errors.New("id_token: e-mail not verified")
	}
	claims.Email = strings.ToLower(claims.Email)
	return &claims, nil
}

// googleAccount finds the account by Google's `sub`; else an e-mail and password account with the same verified e-mail gets Google
// linked; else a new account is made. The refresh token is kept encrypted (AES-GCM with TOKEN_KEY).
func (srv *Server) googleAccount(claims *idClaims, tokens *googleTokens) (string, error) {
	srv.mu.Lock()
	defer srv.mu.Unlock()
	now := stamp(srv.cfg.Now())
	var id string
	err := srv.db.QueryRow(`SELECT id FROM user WHERE google_sub = ?`, claims.Sub).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		var verified bool
		err = srv.db.QueryRow(`SELECT id, email_verified FROM user WHERE email = ? AND google_sub IS NULL`, claims.Email).Scan(&id, &verified)
		if err == nil && !verified {
			// whoever typed this e-mail with a password never proved it: that password and its devices stop working
			if _, err = srv.db.Exec(`UPDATE user SET password_hash = NULL, login_failures = 0, login_blocked_until = NULL WHERE id = ?`, id); err == nil {
				_, err = srv.db.Exec(`UPDATE devices SET signed_out_at = ? WHERE user_id = ? AND signed_out_at IS NULL`, now, id)
			}
		}
		if err == nil {
			_, err = srv.db.Exec(`UPDATE user SET google_sub = ?, email_verified = 1, name = COALESCE(name, NULLIF(?, '')), photo_url = NULLIF(?, ''), updated_at = ? WHERE id = ?`, claims.Sub, claims.Name, claims.Picture, now, id)
		} else if errors.Is(err, sql.ErrNoRows) {
			id = newID()
			_, err = srv.db.Exec(`INSERT INTO user (id, google_sub, email, email_verified, name, photo_url, created_at, updated_at) VALUES (?, ?, ?, 1, NULLIF(?, ''), NULLIF(?, ''), ?, ?)`, id, claims.Sub, claims.Email, claims.Name, claims.Picture, now, now)
		}
	} else if err == nil {
		_, err = srv.db.Exec(`UPDATE user SET name = COALESCE(NULLIF(?, ''), name), photo_url = COALESCE(NULLIF(?, ''), photo_url), updated_at = ? WHERE id = ?`, claims.Name, claims.Picture, now, id)
	}
	if err != nil {
		return "", err
	}
	if tokens.RefreshToken != "" {
		sealed, err := srv.seal(tokens.RefreshToken)
		if err != nil {
			return "", err
		}
		if _, err := srv.db.Exec(`INSERT INTO auth_google (user_id, refresh_token_encrypted, scopes, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET refresh_token_encrypted = excluded.refresh_token_encrypted, scopes = excluded.scopes, updated_at = excluded.updated_at`, id, sealed, tokens.Scope, now); err != nil {
			return "", err
		}
	}
	return id, nil
}

func (srv *Server) seal(plain string) (string, error) {
	block, err := aes.NewCipher(srv.cfg.TokenKey)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	return base64.RawStdEncoding.EncodeToString(gcm.Seal(nonce, nonce, []byte(plain), nil)), nil
}

func (srv *Server) open(sealed string) (string, error) {
	raw, err := base64.RawStdEncoding.DecodeString(sealed)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(srv.cfg.TokenKey)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil || len(raw) < gcm.NonceSize() {
		return "", errors.New("sealed: short")
	}
	plain, err := gcm.Open(nil, raw[:gcm.NonceSize()], raw[gcm.NonceSize():], nil)
	return string(plain), err
}

// jwksCache keeps Google's public keys for an hour; an unknown `kid` fetches them again once.
type jwksCache struct {
	mu      sync.Mutex
	keys    map[string]*rsa.PublicKey
	fetched time.Time
}

func (c *jwksCache) get(r *http.Request, client *http.Client, address, kid string) (*rsa.PublicKey, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if key, ok := c.keys[kid]; ok && time.Since(c.fetched) < time.Hour {
		return key, nil
	}
	request, err := http.NewRequestWithContext(r.Context(), http.MethodGet, address, nil)
	if err != nil {
		return nil, err
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	var set struct {
		Keys []struct {
			Kid string `json:"kid"`
			N   string `json:"n"`
			E   string `json:"e"`
		} `json:"keys"`
	}
	if err := json.NewDecoder(response.Body).Decode(&set); err != nil {
		return nil, err
	}
	c.keys = map[string]*rsa.PublicKey{}
	for _, item := range set.Keys {
		n, err1 := base64.RawURLEncoding.DecodeString(item.N)
		e, err2 := base64.RawURLEncoding.DecodeString(item.E)
		if err1 != nil || err2 != nil {
			continue
		}
		c.keys[item.Kid] = &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: int(new(big.Int).SetBytes(e).Int64())}
	}
	c.fetched = time.Now()
	if key, ok := c.keys[kid]; ok {
		return key, nil
	}
	return nil, errors.New("id_token: unknown key")
}
