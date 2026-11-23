// Package server is the HTTP API of the Estudo backend (spec 003): common rules, sign-in with Google or e-mail and password, and the
// routes of each delivery. Paths, fields and error codes are in English (owner's decision, 2026-11-20).
package server

import (
	"database/sql"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/regyeduardo/study-helper/api/internal/blobs"
)

// GoogleConfig is the Google sign-in done by the server; the URLs are Google's own, replaced by a fake Google in the tests.
type GoogleConfig struct {
	ClientID     string
	ClientSecret string
	AuthURL      string
	TokenURL     string
	JWKSURL      string
	// TokenInfoURL checks an access token the app already holds (sign-in without a second Google screen)
	TokenInfoURL string
	// DriveAboutURL says whose account a Drive-only token is (the app's Drive token carries no e-mail)
	DriveAboutURL string
	// TokenAudiences are other Google clients of the same project whose tokens also open a session (the app's own client)
	TokenAudiences []string
	Issuers        []string
}

// Config is what the service needs from its environment.
type Config struct {
	// AppOrigin is the app's address (https://study.ryns.me): the only origin allowed to call and to change data.
	AppOrigin string
	// PublicURL is this API's address (https://api.study.ryns.me), for the Google redirect.
	PublicURL string
	// AdminEmails are the e-mails of the administration account (a secret, never in the repository).
	AdminEmails []string
	// TokenKey (32 bytes) encrypts the Google refresh tokens and signs the short sign-in cookie.
	TokenKey []byte
	Google   GoogleConfig
	// SecureCookies is false only on a local http setup.
	SecureCookies bool
	Version       string
	Now           func() time.Time
	// HTTPClient talks to Google; the tests give one that reaches the fake Google.
	HTTPClient *http.Client
	// Blobs is where the library's content lives (R2); nil when not configured, and then the App routes answer 503.
	Blobs blobs.Store
	// PartSize is the size of each part of an upload (10 MiB); the tests use a few bytes.
	PartSize int64
	// AI is the app's AI (spec 006): the providers' keys, from the env only.
	AI AIConfig
	// PartTimeout bounds the sending of one upload part to the storage (2 minutes when zero); the tests use a few milliseconds.
	PartTimeout time.Duration
}

// DefaultGoogle is Google's real sign-in.
func DefaultGoogle(clientID, clientSecret string) GoogleConfig {
	return GoogleConfig{
		ClientID:      clientID,
		ClientSecret:  clientSecret,
		AuthURL:       "https://accounts.google.com/o/oauth2/v2/auth",
		TokenURL:      "https://oauth2.googleapis.com/token",
		JWKSURL:       "https://www.googleapis.com/oauth2/v3/certs",
		TokenInfoURL:  "https://oauth2.googleapis.com/tokeninfo",
		DriveAboutURL: "https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName,photoLink,permissionId)",
		Issuers:       []string{"accounts.google.com", "https://accounts.google.com"},
	}
}

// Server holds the database and the settings; Handler gives the routes.
type Server struct {
	db   *sql.DB
	cfg  Config
	keys *jwksCache
	mu   sync.Mutex
	live *hub
}

func New(db *sql.DB, cfg Config) *Server {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.HTTPClient == nil {
		cfg.HTTPClient = &http.Client{Timeout: 15 * time.Second}
	}
	if cfg.PartSize == 0 {
		cfg.PartSize = 10 << 20
	}
	return &Server{db: db, cfg: cfg, keys: &jwksCache{}, live: newHub()}
}

// access says who may call a route: anyone, any signed-in account, or an account freed by a code with "Usar a estrutura do app" on.
type access int

const (
	public access = iota
	signedIn
	appOn
)

type handlerFunc func(w http.ResponseWriter, r *http.Request, s *Session)

// Handler is the whole API, with the common rules in front of every route.
func (srv *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	route := func(pattern string, who access, revokedOK bool, handle handlerFunc) {
		mux.Handle(pattern, srv.rules(who, revokedOK, handle))
	}
	route("GET /v1/health", public, false, srv.health)
	route("GET /v1/me", signedIn, true, srv.me)
	route("POST /v1/auth/password/register", public, false, srv.register)
	route("POST /v1/auth/password/login", public, false, srv.login)
	route("POST /v1/auth/logout", signedIn, true, srv.logout)
	route("GET /v1/auth/google/start", public, false, srv.googleStart)
	route("GET /v1/auth/google/callback", public, false, srv.googleCallback)
	route("POST /v1/auth/google/token", public, false, srv.googleToken)
	route("POST /v1/code/use", signedIn, false, srv.useCode)
	route("POST /v1/structure", signedIn, false, srv.setStructure)
	route("GET /v1/devices", signedIn, false, srv.devices)
	route("PATCH /v1/devices/{id}", signedIn, false, srv.renameDevice)
	route("DELETE /v1/devices/{id}", signedIn, false, srv.signOutDevice)
	// spec 005: the map is the hierarchy of every signed-in account, with or without the structure; it never touches the storage
	route("GET /v1/library/map", signedIn, false, srv.libraryMap)
	route("GET /v1/library/items/{id}", signedIn, false, srv.getLibraryItem)
	route("PUT /v1/library/items/{id}", signedIn, false, srv.putLibraryItem)
	route("DELETE /v1/library/items/{id}", signedIn, false, srv.deleteLibraryItem)
	route("POST /v1/library/items/batch", signedIn, false, srv.libraryBatch)
	route("POST /v1/library/hierarchy/backup", signedIn, false, srv.hierarchyBackup)
	route("POST /v1/library/hierarchy/done", signedIn, false, srv.hierarchyDone)
	route("GET /v1/live", signedIn, false, srv.liveChannel)
	// spec 006: the app's AI, only with the structure on; the key is the server's
	route("GET /v1/ai/config", appOn, false, srv.aiConfig)
	route("/v1/ai/{provider}/{path...}", appOn, false, srv.aiProxy)
	// entrega 4: the content kept in the App
	app := func(pattern string, handle handlerFunc) { route(pattern, appOn, false, srv.withBlobs(handle)) }
	app("GET /v1/library/items/{id}/parts/{part...}", srv.getPart)
	app("PUT /v1/library/items/{id}/parts/{part...}", srv.putPart)
	app("DELETE /v1/library/items/{id}/parts/{part...}", srv.deletePart)
	app("POST /v1/library/parts/batch", srv.partsBatch)
	app("GET /v1/library/index", srv.getIndex)
	app("PUT /v1/library/index", srv.putIndex)
	app("POST /v1/uploads", srv.startUpload)
	app("GET /v1/uploads/{id}", srv.getUpload)
	app("PUT /v1/uploads/{id}/parts/{n}", srv.putUploadPart)
	app("POST /v1/uploads/{id}/complete", srv.completeUpload)
	app("DELETE /v1/uploads/{id}", srv.abandonUpload)
	app("GET /v1/media/{item}/{media}", srv.getMedia)
	app("DELETE /v1/media/{item}/{media}", srv.deleteMedia)
	adminRoute := func(pattern string, handle handlerFunc) { mux.Handle(pattern, srv.adminOnly(handle)) }
	adminRoute("GET /v1/admin/codes", srv.adminCodes)
	adminRoute("POST /v1/admin/codes", srv.adminCreateCode)
	adminRoute("POST /v1/admin/codes/{id}/cancel", srv.adminCancelCode)
	adminRoute("GET /v1/admin/accounts", srv.adminAccounts)
	adminRoute("POST /v1/admin/accounts/{id}/revoke", srv.adminRevoke)
	adminRoute("GET /v1/admin/settings", srv.adminSettings)
	adminRoute("PUT /v1/admin/settings", srv.adminSetSettings)
	adminRoute("GET /v1/admin/ai", srv.adminAI)
	adminRoute("PUT /v1/admin/ai", srv.adminSetAI)
	mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fail(w, http.StatusNotFound, "not_found", nil) }))
	return srv.cors(mux)
}

// cors lets only the app call with its cookie; a preflight is answered here.
func (srv *Server) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && origin == srv.cfg.AppOrigin {
			h := w.Header()
			h.Set("Access-Control-Allow-Origin", origin)
			h.Set("Access-Control-Allow-Credentials", "true")
			h.Add("Vary", "Origin")
			// the app saves a note's parts with If-Match / If-None-Match and reads the new version from ETag
			h.Set("Access-Control-Expose-Headers", "ETag")
			if r.Method == http.MethodOptions {
				h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE")
				h.Set("Access-Control-Allow-Headers", "Content-Type, X-Estudo, If-Match, If-None-Match")
				// the app's AI (spec 006) sends the provider's own headers; the keys among them are dropped before the provider
				if strings.HasPrefix(r.URL.Path, "/v1/ai/") {
					if asked := r.Header.Get("Access-Control-Request-Headers"); asked != "" {
						h.Set("Access-Control-Allow-Headers", asked)
					}
				}
				h.Set("Access-Control-Max-Age", "600")
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

var changes = map[string]bool{http.MethodPost: true, http.MethodPut: true, http.MethodPatch: true, http.MethodDelete: true}

// rules are the common rules of the whole API, in this order: a change comes from the app (`X-Estudo: 1` and the app's `Origin`);
// the session; an account whose access was taken away reaches only its "me" and sign-out; the App routes need a freed account with the
// structure on.
func (srv *Server) rules(who access, revokedOK bool, handle handlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if changes[r.Method] && (r.Header.Get("X-Estudo") != "1" || r.Header.Get("Origin") != srv.cfg.AppOrigin) {
			fail(w, http.StatusForbidden, "origin_refused", nil)
			return
		}
		var session *Session
		if who != public {
			found, err := srv.sessionOf(r)
			if err != nil {
				fail(w, http.StatusInternalServerError, "internal_error", nil)
				return
			}
			if found == nil {
				fail(w, http.StatusUnauthorized, "no_session", nil)
				return
			}
			if found.User.Status == "revoked" && !revokedOK {
				fail(w, http.StatusForbidden, "access_revoked", map[string]any{"deleteAt": found.User.DeleteAt})
				return
			}
			if who == appOn && !structureOn(found.User) {
				fail(w, http.StatusForbidden, "app_disabled", nil)
				return
			}
			session = found
		}
		handle(w, r, session)
	})
}

// structureOn says whether the account is freed by a code with "Usar a estrutura do app" on.
func structureOn(user User) bool { return user.Status == "enabled" && user.AppEnabled }

// adminOf says whether the account is the administration: its e-mail is in ADMIN_EMAILS and was proven (by Google). An e-mail typed
// with a password proves nothing.
func (srv *Server) adminOf(user User) bool {
	if !user.EmailVerified {
		return false
	}
	for _, admin := range srv.cfg.AdminEmails {
		if strings.EqualFold(strings.TrimSpace(admin), user.Email) {
			return true
		}
	}
	return false
}

func (srv *Server) health(w http.ResponseWriter, _ *http.Request, _ *Session) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "version": srv.cfg.Version})
}
