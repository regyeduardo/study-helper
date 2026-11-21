package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// The live channel (spec 003, entrega 4, contract api-biblioteca.md): each device of an account keeps a WebSocket open at /v1/live
// and hears when the map changed ({"type":"map","seq"}), the space ({"type":"space",…}) and the access ({"type":"access",…}).
// A device says what it has ({"type":"hello","seq"}) and, if the server has more, hears "map" right away. Without the channel the
// app asks the map every 15 s.

type hub struct {
	mu    sync.Mutex
	conns map[string]map[*websocket.Conn]bool
}

func newHub() *hub { return &hub{conns: map[string]map[*websocket.Conn]bool{}} }

func (h *hub) add(userID string, conn *websocket.Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.conns[userID] == nil {
		h.conns[userID] = map[*websocket.Conn]bool{}
	}
	h.conns[userID][conn] = true
}

func (h *hub) remove(userID string, conn *websocket.Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.conns[userID], conn)
	if len(h.conns[userID]) == 0 {
		delete(h.conns, userID)
	}
}

func (h *hub) send(userID string, message any) {
	raw, err := json.Marshal(message)
	if err != nil {
		return
	}
	h.mu.Lock()
	targets := make([]*websocket.Conn, 0, len(h.conns[userID]))
	for conn := range h.conns[userID] {
		targets = append(targets, conn)
	}
	h.mu.Unlock()
	for _, conn := range targets {
		go func(conn *websocket.Conn) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = conn.Write(ctx, websocket.MessageText, raw)
		}(conn)
	}
}

func (srv *Server) notifyMap(userID string, seq int64) {
	srv.live.send(userID, map[string]any{"type": "map", "seq": seq})
}

func (srv *Server) notifySpace(userID string) {
	notes, media, reserved, err := srv.space(srv.db, userID)
	if err != nil {
		return
	}
	srv.live.send(userID, map[string]any{"type": "space", "notes": notes, "media": media, "reserved": reserved})
}

// notifyAccess tells every device of the account that its access was taken away.
func (srv *Server) notifyAccess(userID, deleteAt string) {
	srv.live.send(userID, map[string]any{"type": "access", "status": "revoked", "deleteAt": deleteAt})
}

func (srv *Server) liveChannel(w http.ResponseWriter, r *http.Request, s *Session) {
	// a page of another site cannot open the channel with the person's cookie
	if r.Header.Get("Origin") != srv.cfg.AppOrigin {
		fail(w, http.StatusForbidden, "origin_refused", nil)
		return
	}
	app, err := url.Parse(srv.cfg.AppOrigin)
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: []string{app.Host}})
	if err != nil {
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(4096)
	srv.live.add(s.User.ID, conn)
	defer srv.live.remove(s.User.ID, conn)
	ctx := r.Context()
	for {
		_, raw, err := conn.Read(ctx)
		if err != nil {
			return
		}
		var message struct {
			Type string `json:"type"`
			Seq  int64  `json:"seq"`
		}
		if json.Unmarshal(raw, &message) != nil || message.Type != "hello" {
			continue
		}
		var seq int64
		if srv.db.QueryRow(`SELECT seq FROM user WHERE id = ?`, s.User.ID).Scan(&seq) == nil && seq > message.Seq {
			reply, _ := json.Marshal(map[string]any{"type": "map", "seq": seq})
			_ = conn.Write(ctx, websocket.MessageText, reply)
		}
	}
}
