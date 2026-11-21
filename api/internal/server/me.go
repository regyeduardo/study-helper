package server

import "net/http"

const (
	// spaceLimit: each account has up to 10 GB in the App; the app warns at 90% (FR-044).
	spaceLimit   = int64(10) << 30
	spaceWarning = 0.9
)

// me is who is signed in, whether a promo code is required, this device and the space.
func (srv *Server) me(w http.ResponseWriter, _ *http.Request, s *Session) {
	required := "1"
	_ = srv.db.QueryRow(`SELECT value FROM app_settings WHERE key = 'require_code'`).Scan(&required)
	user := s.User
	writeJSON(w, http.StatusOK, map[string]any{
		"user": map[string]any{
			"id": user.ID, "email": user.Email, "name": nullable(user.Name.String, user.Name.Valid), "photoUrl": nullable(user.PhotoURL.String, user.PhotoURL.Valid),
			"status": user.Status, "appEnabled": user.AppEnabled, "admin": srv.isAdmin(user.Email), "deleteAt": user.DeleteAt,
			"hasPassword": user.HasPassword, "hasGoogle": user.HasGoogle,
		},
		"requireCode": required == "1",
		"device":      map[string]any{"id": s.DeviceID, "name": s.Device},
		"space":       map[string]any{"notes": user.NotesBytes, "media": user.MediaBytes, "reserved": user.Reserved, "limit": spaceLimit, "warnAt": spaceWarning},
	})
}

func nullable(value string, valid bool) any {
	if !valid {
		return nil
	}
	return value
}
