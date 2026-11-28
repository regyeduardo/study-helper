package server

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"
)

// T210 (dono, 28/11: "JWT na autenticação"; FR-085): each request is signed in by a short access token, a JWT signed with HS256, that
// is checked without going to the database. The session cookie of before is the renewal: kept (hashed) in the server, it is read only
// when the access token is missing, expired or older than a change of the account, and then a new access token goes with the answer,
// in the same request (the app changes nothing). Taking the access away, signing a device out or freeing the account marks the account
// as changed here, so its tokens are renewed (and refused) at once; after a restart, an old token lasts at most its 5 minutes.

const (
	accessCookie = "estudo_access"
	accessTTL    = 5 * time.Minute
)

var jwtHeader = base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))

type accessClaims struct {
	Sub    string  `json:"sub"`
	Device string  `json:"dev"`
	Name   string  `json:"dn,omitempty"`
	Email  string  `json:"em"`
	Proven bool    `json:"ev,omitempty"`
	Status string  `json:"st"`
	App    bool    `json:"app,omitempty"`
	Delete *string `json:"del,omitempty"`
	Iat    int64   `json:"iat"`
	Exp    int64   `json:"exp"`
}

// accessTokens signs and checks the access tokens, and knows which accounts changed since their tokens were made.
type accessTokens struct {
	key     []byte
	mu      sync.Mutex
	changed map[string]time.Time
}

func newAccessTokens(tokenKey []byte) *accessTokens {
	key := make([]byte, 32)
	if len(tokenKey) > 0 {
		mac := hmac.New(sha256.New, tokenKey)
		mac.Write([]byte("estudo: token de acesso"))
		key = mac.Sum(nil)
	} else {
		_, _ = rand.Read(key)
	}
	return &accessTokens{key: key, changed: map[string]time.Time{}}
}

func (a *accessTokens) sign(payload string) string {
	mac := hmac.New(sha256.New, a.key)
	mac.Write([]byte(jwtHeader + "." + payload))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (a *accessTokens) make(s *Session, now time.Time) string {
	claims := accessClaims{Sub: s.User.ID, Device: s.DeviceID, Name: s.Device, Email: s.User.Email, Proven: s.User.EmailVerified, Status: s.User.Status, App: s.User.AppEnabled, Delete: s.User.DeleteAt, Iat: now.Unix(), Exp: now.Add(accessTTL).Unix()}
	raw, _ := json.Marshal(claims)
	payload := base64.RawURLEncoding.EncodeToString(raw)
	return jwtHeader + "." + payload + "." + a.sign(payload)
}

// read is the session of a valid token: signed here, with this header only (no "alg": "none"), not expired, made after the last change
// of its account. Nil: it has to be renewed.
func (a *accessTokens) read(token string, now time.Time) *Session {
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[0] != jwtHeader || !hmac.Equal([]byte(parts[2]), []byte(a.sign(parts[1]))) {
		return nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil
	}
	var claims accessClaims
	if json.Unmarshal(raw, &claims) != nil || claims.Sub == "" || now.Unix() >= claims.Exp {
		return nil
	}
	a.mu.Lock()
	changed, ok := a.changed[claims.Sub]
	a.mu.Unlock()
	if ok && claims.Iat <= changed.Unix() {
		return nil
	}
	return &Session{User: User{ID: claims.Sub, Email: claims.Email, EmailVerified: claims.Proven, Status: claims.Status, AppEnabled: claims.App, DeleteAt: claims.Delete}, DeviceID: claims.Device, Device: claims.Name}
}

// accountChanged: the tokens of the account made until now are renewed at their next request (and refused if the change says so).
func (a *accessTokens) accountChanged(userID string, now time.Time) {
	a.mu.Lock()
	defer a.mu.Unlock()
	for id, at := range a.changed {
		if now.Sub(at) > accessTTL+time.Minute {
			delete(a.changed, id)
		}
	}
	a.changed[userID] = now
}

// accountChanged marks the account as changed for its access tokens (T210).
func (srv *Server) accountChanged(userID string) { srv.tokens.accountChanged(userID, srv.cfg.Now()) }

// authenticate is the session of the request: by the access token, without the database; otherwise renewed by the session cookie, with
// a new access token in the answer. Nil: nobody is signed in.
func (srv *Server) authenticate(w http.ResponseWriter, r *http.Request) (*Session, error) {
	now := srv.cfg.Now()
	if cookie, err := r.Cookie(accessCookie); err == nil {
		if session := srv.tokens.read(cookie.Value, now); session != nil {
			return session, nil
		}
	}
	session, err := srv.sessionOf(r)
	if err != nil || session == nil {
		if err == nil {
			if _, had := r.Cookie(accessCookie); had == nil {
				http.SetCookie(w, &http.Cookie{Name: accessCookie, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, Secure: srv.cfg.SecureCookies, SameSite: http.SameSiteLaxMode})
			}
		}
		return session, err
	}
	http.SetCookie(w, &http.Cookie{Name: accessCookie, Value: srv.tokens.make(session, now), Path: "/", MaxAge: int(accessTTL / time.Second), HttpOnly: true, Secure: srv.cfg.SecureCookies, SameSite: http.SameSiteLaxMode})
	return session, nil
}
