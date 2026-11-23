package server

import (
	"encoding/json"
	"net/http"
	"sort"
	"strings"
)

// Spec 006: the app's AI for the people with the structure on (spec 003, FR-027, FR-032). The browser calls
// /v1/ai/{provider}/{path...} with the provider's own path, no key; the server sends it on to the provider with the key of the env
// (AI_KEY_<PROVIDER>) and streams the answer back. The key never reaches the browser. The administration account chooses, per use,
// the model everyone with the structure uses (app_settings "ai_uses").

// AIConfig is the app's AI: the providers' keys (from the env only) and, in the tests, other addresses for them.
type AIConfig struct {
	Keys    map[string]string
	Origins map[string]string
}

// aiOrigins are the providers of src/lib/ai/providers.ts ("Personalizado" never: it has no fixed address).
var aiOrigins = map[string]string{
	"deepinfra":  "https://api.deepinfra.com",
	"openrouter": "https://openrouter.ai",
	"vercel":     "https://ai-gateway.vercel.sh",
	"deepseek":   "https://api.deepseek.com",
	"xai":        "https://api.x.ai",
	"anthropic":  "https://api.anthropic.com",
	"mistral":    "https://api.mistral.ai",
	"openai":     "https://api.openai.com",
	"gemini":     "https://generativelanguage.googleapis.com",
	"groq":       "https://api.groq.com",
	"together":   "https://api.together.xyz",
}

// AIProviders are the provider ids the server knows, for the env.
func AIProviders() []string {
	out := make([]string, 0, len(aiOrigins))
	for id := range aiOrigins {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

const maxAIUsesBytes = 64 << 10

// what the browser sends that never goes to the provider: its keys, its cookies and the request's own path
var aiDropped = map[string]bool{"Authorization": true, "X-Api-Key": true, "X-Goog-Api-Key": true, "Cookie": true, "Origin": true, "Referer": true, "X-Estudo": true, "Host": true, "Connection": true, "Content-Length": true, "Accept-Encoding": true}

func (srv *Server) aiOrigin(provider string) (string, bool) {
	if origin, ok := srv.cfg.AI.Origins[provider]; ok {
		return origin, true
	}
	origin, ok := aiOrigins[provider]
	return origin, ok
}

// configuredAI is the providers with a key in the env, in order.
func (srv *Server) configuredAI() []string {
	out := []string{}
	for id, key := range srv.cfg.AI.Keys {
		if _, known := srv.aiOrigin(id); known && key != "" {
			out = append(out, id)
		}
	}
	sort.Strings(out)
	return out
}

func (srv *Server) aiProxy(w http.ResponseWriter, r *http.Request, s *Session) {
	provider := r.PathValue("provider")
	origin, known := srv.aiOrigin(provider)
	if !known {
		fail(w, http.StatusNotFound, "unknown_provider", nil)
		return
	}
	key := srv.cfg.AI.Keys[provider]
	if key == "" {
		fail(w, http.StatusServiceUnavailable, "ai_not_configured", map[string]any{"provider": provider})
		return
	}
	target := strings.TrimRight(origin, "/") + "/" + r.PathValue("path")
	if r.URL.RawQuery != "" {
		target += "?" + r.URL.RawQuery
	}
	out, err := http.NewRequestWithContext(r.Context(), r.Method, target, r.Body)
	if err != nil {
		fail(w, http.StatusBadRequest, "invalid_body", nil)
		return
	}
	out.ContentLength = r.ContentLength
	for name, values := range r.Header {
		if aiDropped[http.CanonicalHeaderKey(name)] || strings.HasPrefix(http.CanonicalHeaderKey(name), "Sec-") {
			continue
		}
		for _, value := range values {
			out.Header.Add(name, value)
		}
	}
	switch provider {
	case "anthropic":
		out.Header.Set("X-Api-Key", key)
		if out.Header.Get("Anthropic-Version") == "" {
			out.Header.Set("Anthropic-Version", "2023-06-01")
		}
	case "gemini":
		// the OpenAI-like address takes the Bearer; the Gemini one, x-goog-api-key
		out.Header.Set("Authorization", "Bearer "+key)
		out.Header.Set("X-Goog-Api-Key", key)
	default:
		out.Header.Set("Authorization", "Bearer "+key)
	}
	client := srv.cfg.HTTPClient
	if client == nil || srv.cfg.AI.Origins[provider] != "" {
		client = http.DefaultClient
	}
	res, err := client.Do(out)
	if err != nil {
		fail(w, http.StatusBadGateway, "ai_unreachable", map[string]any{"provider": provider})
		return
	}
	defer res.Body.Close()
	for name, values := range res.Header {
		if name == "Set-Cookie" || name == "Content-Length" || name == "Connection" || strings.HasPrefix(name, "Access-Control-") {
			continue
		}
		for _, value := range values {
			w.Header().Add(name, value)
		}
	}
	w.WriteHeader(res.StatusCode)
	// the answer goes as it comes (the AI writes in parts)
	flusher, _ := w.(http.Flusher)
	buffer := make([]byte, 16<<10)
	for {
		n, readErr := res.Body.Read(buffer)
		if n > 0 {
			if _, err := w.Write(buffer[:n]); err != nil {
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if readErr != nil {
			return
		}
	}
}

// aiUses is what the administration chose for each use, as kept ({} when nothing yet).
func (srv *Server) aiUses() json.RawMessage {
	var value string
	if err := srv.db.QueryRow(`SELECT value FROM app_settings WHERE key = 'ai_uses'`).Scan(&value); err != nil || value == "" {
		return json.RawMessage(`{}`)
	}
	return json.RawMessage(value)
}

// aiConfig: the providers the app's AI has and the model of each use, for a person with the structure on. Never a key.
func (srv *Server) aiConfig(w http.ResponseWriter, r *http.Request, s *Session) {
	writeJSON(w, http.StatusOK, map[string]any{"providers": srv.configuredAI(), "uses": srv.aiUses()})
}

func (srv *Server) adminAI(w http.ResponseWriter, r *http.Request, s *Session) {
	writeJSON(w, http.StatusOK, map[string]any{"providers": srv.configuredAI(), "known": AIProviders(), "uses": srv.aiUses()})
}

func (srv *Server) adminSetAI(w http.ResponseWriter, r *http.Request, s *Session) {
	raw, ok := readBody(r, maxAIUsesBytes)
	var body struct {
		Uses map[string]json.RawMessage `json:"uses"`
	}
	if !ok || json.Unmarshal(raw, &body) != nil || body.Uses == nil {
		fail(w, http.StatusBadRequest, "invalid_body", nil)
		return
	}
	uses, err := json.Marshal(body.Uses)
	if err != nil {
		fail(w, http.StatusBadRequest, "invalid_body", nil)
		return
	}
	if _, err := srv.db.Exec(`INSERT INTO app_settings (key, value) VALUES ('ai_uses', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, string(uses)); err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"uses": json.RawMessage(uses)})
}
