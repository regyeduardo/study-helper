package server

import (
	"bytes"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"io"
	"math/big"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/regyeduardo/study-helper/api/internal/blobs"
	"github.com/regyeduardo/study-helper/api/internal/store"
)

const (
	appOrigin = "https://study.test"
	clientID  = "estudo-client-id.apps.googleusercontent.com"
)

type harness struct {
	t      *testing.T
	db     *sql.DB
	srv    *Server
	api    *httptest.Server
	google *fakeGoogle
	blobs  *blobs.Memory
	// now is the clock the server reads; tests move it
	now time.Time
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "estudo.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	google := newFakeGoogle(t)
	key := bytes.Repeat([]byte{7}, 32)
	h := &harness{t: t, db: db, google: google, blobs: blobs.NewMemory(), now: time.Now().UTC()}
	h.api = httptest.NewServer(nil)
	cfg := Config{
		AppOrigin: appOrigin, PublicURL: h.api.URL, AdminEmails: []string{"dono@exemplo.com"}, TokenKey: key,
		Google:  GoogleConfig{ClientID: clientID, ClientSecret: "segredo-do-cliente", AuthURL: google.URL + "/auth", TokenURL: google.URL + "/token", JWKSURL: google.URL + "/jwks", TokenInfoURL: google.URL + "/tokeninfo", DriveAboutURL: google.URL + "/about", Issuers: []string{"https://accounts.google.com"}},
		Version: "teste", HTTPClient: google.Client(),
		Blobs: h.blobs, PartSize: 4, Now: func() time.Time { return h.now },
	}
	h.srv = New(db, cfg)
	h.api.Config.Handler = h.srv.Handler()
	t.Cleanup(h.api.Close)
	return h
}

// browser is a client with its own cookies that never follows redirects (the tests read where each one goes).
func (h *harness) browser() *http.Client {
	jar, _ := cookiejar.New(nil)
	return &http.Client{Jar: jar, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

type call struct {
	method string
	path   string
	body   any
	// origin is the app's by default on changes; "-" sends none
	origin string
	noMark bool
}

func (h *harness) do(client *http.Client, c call) (*http.Response, map[string]any) {
	h.t.Helper()
	var reader *bytes.Reader
	if c.body != nil {
		raw, _ := json.Marshal(c.body)
		reader = bytes.NewReader(raw)
	} else {
		reader = bytes.NewReader(nil)
	}
	method := c.method
	if method == "" {
		method = http.MethodGet
	}
	request, _ := http.NewRequest(method, h.api.URL+c.path, reader)
	if method != http.MethodGet {
		if !c.noMark {
			request.Header.Set("X-Estudo", "1")
		}
		switch c.origin {
		case "":
			request.Header.Set("Origin", appOrigin)
		case "-":
		default:
			request.Header.Set("Origin", c.origin)
		}
		request.Header.Set("Content-Type", "application/json")
	}
	request.Header.Set("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0 Safari/537.36")
	response, err := client.Do(request)
	if err != nil {
		h.t.Fatal(err)
	}
	defer response.Body.Close()
	var body map[string]any
	_ = json.NewDecoder(response.Body).Decode(&body)
	return response, body
}

// account makes an account straight in the database with a signed-in device, and gives a browser holding its session.
func (h *harness) account(status string, appEnabled bool, email string) (*http.Client, string) {
	h.t.Helper()
	id := newID()
	now := time.Now().UTC()
	enabled := 0
	if appEnabled {
		enabled = 1
	}
	var deleteAt any
	if status == "revoked" {
		deleteAt = stamp(now.Add(30 * 24 * time.Hour))
	}
	if _, err := h.db.Exec(`INSERT INTO user (id, email, name, status, app_enabled, delete_at, created_at, updated_at) VALUES (?, ?, 'Ana Teste', ?, ?, ?, ?, ?)`, id, email, status, enabled, deleteAt, stamp(now), stamp(now)); err != nil {
		h.t.Fatal(err)
	}
	token := randomToken(32)
	if _, err := h.db.Exec(`INSERT INTO devices (id, user_id, session_hash, name, created_at, seen_at, expires_at) VALUES (?, ?, ?, 'Chrome no Linux', ?, ?, ?)`, newID(), id, sha256Hex(token), stamp(now), stamp(now), stamp(now.Add(180*24*time.Hour))); err != nil {
		h.t.Fatal(err)
	}
	client := h.browser()
	target, _ := url.Parse(h.api.URL)
	client.Jar.SetCookies(target, []*http.Cookie{{Name: sessionCookie, Value: token, Path: "/"}})
	return client, id
}

// fakeGoogle plays Google's sign-in: it signs id_tokens with a test key and serves the matching public key.
type fakeGoogle struct {
	*httptest.Server
	key      *rsa.PrivateKey
	mu       sync.Mutex
	codes    map[string]fakeCode
	failNext bool
	// tokens are the access tokens Google knows, with what /tokeninfo says about each
	tokens map[string]map[string]any
}

// grant makes Google know an access token, answering /tokeninfo with these fields.
func (g *fakeGoogle) grant(token string, info map[string]any) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.tokens[token] = info
}

type fakeCode struct {
	// challenge is the PKCE code_challenge the API sent at the start: the token answer needs the verifier that matches it
	challenge string
	claims    map[string]any
	refresh   string
	signWith  *rsa.PrivateKey
}

func newFakeGoogle(t *testing.T) *fakeGoogle {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	g := &fakeGoogle{key: key, codes: map[string]fakeCode{}, tokens: map[string]map[string]any{}}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /about", func(w http.ResponseWriter, r *http.Request) {
		g.mu.Lock()
		info, ok := g.tokens[strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")]
		g.mu.Unlock()
		email, _ := info["_drive_email"].(string)
		if !ok || email == "" {
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"user": map[string]any{"emailAddress": email, "displayName": "Dono", "permissionId": "p-1"}})
	})
	mux.HandleFunc("GET /tokeninfo", func(w http.ResponseWriter, r *http.Request) {
		g.mu.Lock()
		info, ok := g.tokens[r.URL.Query().Get("access_token")]
		g.mu.Unlock()
		if !ok || info["expires_in"] == "0" {
			http.Error(w, `{"error":"invalid_token"}`, http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(w).Encode(info)
	})
	mux.HandleFunc("GET /jwks", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]any{{"kty": "RSA", "alg": "RS256", "kid": "chave-1", "n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()), "e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes())}}})
	})
	mux.HandleFunc("POST /token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		g.mu.Lock()
		code, ok := g.codes[r.Form.Get("code")]
		fail := g.failNext
		g.failNext = false
		g.mu.Unlock()
		if fail {
			http.Error(w, "fora do ar", http.StatusServiceUnavailable)
			return
		}
		sum := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
		if !ok || r.Form.Get("client_secret") != "segredo-do-cliente" || base64.RawURLEncoding.EncodeToString(sum[:]) != code.challenge || r.Form.Get("grant_type") != "authorization_code" {
			http.Error(w, `{"error":"invalid_grant"}`, http.StatusBadRequest)
			return
		}
		signer := code.signWith
		if signer == nil {
			signer = key
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"id_token": signIDToken(signer, code.claims), "refresh_token": code.refresh, "access_token": "acesso", "expires_in": 3599, "scope": "openid email profile"})
	})
	g.Server = httptest.NewServer(mux)
	t.Cleanup(g.Close)
	return g
}

func signIDToken(key *rsa.PrivateKey, claims map[string]any) string {
	header, _ := json.Marshal(map[string]any{"alg": "RS256", "kid": "chave-1", "typ": "JWT"})
	payload, _ := json.Marshal(claims)
	unsigned := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(payload)
	digest := sha256.Sum256([]byte(unsigned))
	signature, _ := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	return unsigned + "." + base64.RawURLEncoding.EncodeToString(signature)
}

// claimsFor are the claims Google gives for a verified account of this app.
func claimsFor(sub, email string) map[string]any {
	return map[string]any{"iss": "https://accounts.google.com", "aud": clientID, "sub": sub, "email": email, "email_verified": true, "name": "Ana Souza", "picture": "https://foto.test/ana.png", "exp": time.Now().Add(time.Hour).Unix(), "iat": time.Now().Unix()}
}

// start runs "Entrar com o Google" up to Google: it returns the browser (holding the short sign-in cookie) and Google's query.
func (h *harness) start(returnTo string) (*http.Client, url.Values) {
	h.t.Helper()
	client := h.browser()
	response, _ := h.do(client, call{path: "/v1/auth/google/start?return_to=" + url.QueryEscape(returnTo)})
	if response.StatusCode != http.StatusFound {
		h.t.Fatalf("start = %d, want 302", response.StatusCode)
	}
	location, _ := url.Parse(response.Header.Get("Location"))
	if !strings.HasPrefix(location.String(), h.google.URL+"/auth?") {
		h.t.Fatalf("start went to %s", location)
	}
	return client, location.Query()
}

// googleGives makes Google answer a code for these claims, bound to the PKCE challenge of that start (only the API knows the verifier).
func (h *harness) googleGives(code string, google url.Values, claims map[string]any, refresh string, signWith *rsa.PrivateKey) {
	h.google.mu.Lock()
	defer h.google.mu.Unlock()
	h.google.codes[code] = fakeCode{challenge: google.Get("code_challenge"), claims: claims, refresh: refresh, signWith: signWith}
}

// finish comes back from Google to the callback with a code (or an error) and the state.
func (h *harness) finish(client *http.Client, query string) *http.Response {
	h.t.Helper()
	response, _ := h.do(client, call{path: "/v1/auth/google/callback?" + query})
	return response
}

// raw is a call with a body and headers of its own (parts, uploads, media), the app's mark and origin on changes.
func (h *harness) raw(client *http.Client, method, path string, body []byte, headers map[string]string) (*http.Response, []byte) {
	h.t.Helper()
	request, _ := http.NewRequest(method, h.api.URL+path, bytes.NewReader(body))
	if method != http.MethodGet && method != http.MethodHead {
		request.Header.Set("X-Estudo", "1")
		request.Header.Set("Origin", appOrigin)
	}
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	response, err := client.Do(request)
	if err != nil {
		h.t.Fatal(err)
	}
	defer response.Body.Close()
	out, _ := io.ReadAll(response.Body)
	return response, out
}
