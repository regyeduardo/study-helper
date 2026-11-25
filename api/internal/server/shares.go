package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
)

// The live link of who uses the app structure (spec 003, história 7, FR-034 to FR-036, FR-063; contracts/api-compartilhar.md):
// sharing keeps only the pointer (account, item, choices) in shared_links; nothing is copied, nothing is sent again. Whoever has the
// link reads the item as it is now, from the map and the parts of the account, and plays the media straight from the App. Without the
// structure, links stay with the share-worker, as before.

// sourceTypes are the note types that keep a source (once "Entradas"): shared, they go with the notes born of them (FR-066).
var sourceTypes = map[string]bool{"video": true, "audio": true, "pdf": true, "link": true, "text": true, "topic": true, "document": true}

// artifactKinds are the artifacts a link can carry.
var artifactKinds = map[string]bool{"mapa": true, "cartoes": true, "tutor": true}

var (
	errLinkGone  = errors.New("item_removed")
	errNotInApp  = errors.New("not_in_app")
	errNoLinkRow = errors.New("share_not_found")
)

type sharedLink struct {
	ID        string
	UserID    string
	ItemID    string
	ItemKind  string
	WithExams bool
	Artifacts []string
	CreatedAt string
	Stopped   bool
	// spec 007 (história 4): nil = Permanente; UpdatedAt is when the deadline was last chosen
	ExpiresAt *string
	UpdatedAt string
}

const linkColumns = `id, user_id, item_id, item_kind, with_exams, artifacts, created_at, stopped_at IS NOT NULL, expires_at, updated_at`

// linkDeadlines are the deadlines a link may have (spec 007, FR-032): 1, 3 or 7 days, or Permanente.
var linkDeadlines = map[string]time.Duration{"1d": 24 * time.Hour, "3d": 3 * 24 * time.Hour, "7d": 7 * 24 * time.Hour, "never": 0}

func scanLink(row scanner) (*sharedLink, error) {
	var link sharedLink
	var withExams int
	var artifacts string
	var expires sql.NullString
	if err := row.Scan(&link.ID, &link.UserID, &link.ItemID, &link.ItemKind, &withExams, &artifacts, &link.CreatedAt, &link.Stopped, &expires, &link.UpdatedAt); err != nil {
		return nil, err
	}
	if expires.Valid {
		link.ExpiresAt = &expires.String
	}
	link.WithExams = withExams == 1
	_ = json.Unmarshal([]byte(artifacts), &link.Artifacts)
	return &link, nil
}

// isSourceRow: a note that keeps a source, by its type or, in a library from before, by `role: 'entrada'`.
func isSourceRow(row *libraryRow) bool {
	if row.NoteType != nil && sourceTypes[*row.NoteType] {
		return true
	}
	var meta struct {
		Role string `json:"role"`
	}
	_ = json.Unmarshal(row.Meta, &meta)
	return meta.Role == "entrada"
}

// kindOf is what the link carries: a folder, an entrada (the note and its family) or a note alone.
func kindOf(itemKind string, root *libraryRow) string {
	if itemKind == "folder" {
		return "folder"
	}
	if root != nil && isSourceRow(root) {
		return "entrada"
	}
	return "file"
}

func (srv *Server) linkOut(link *sharedLink, kind, title string) map[string]any {
	artifacts := link.Artifacts
	if artifacts == nil {
		artifacts = []string{}
	}
	return map[string]any{"id": link.ID, "itemId": link.ItemID, "kind": kind, "title": title, "live": true, "withExams": link.WithExams, "artifacts": artifacts, "createdAt": link.CreatedAt,
		"updatedAt": link.UpdatedAt, "expiresIn": deadlineOf(link), "expiresAt": link.ExpiresAt, "expired": srv.expired(link), "url": strings.TrimRight(srv.cfg.PublicURL, "/") + "/s/" + link.ID}
}

// deadlineOf is the deadline chosen: the time from when it was chosen to when it ends, in days.
func deadlineOf(link *sharedLink) string {
	if link.ExpiresAt == nil {
		return "never"
	}
	end, err1 := time.Parse(time.RFC3339, *link.ExpiresAt)
	from, err2 := time.Parse(time.RFC3339, link.UpdatedAt)
	if err1 != nil || err2 != nil {
		return "1d"
	}
	switch days := int(end.Sub(from).Round(time.Hour).Hours() / 24); {
	case days >= 7:
		return "7d"
	case days >= 3:
		return "3d"
	default:
		return "1d"
	}
}

func (srv *Server) expired(link *sharedLink) bool {
	if link.ExpiresAt == nil {
		return false
	}
	end, err := time.Parse(time.RFC3339, *link.ExpiresAt)
	return err == nil && !end.After(srv.now())
}

// expiryFrom is when a deadline chosen now ends (nil: Permanente); false when it is not one of the four.
func (srv *Server) expiryFrom(deadline string) (any, bool) {
	if deadline == "" {
		deadline = "never"
	}
	span, ok := linkDeadlines[deadline]
	if !ok {
		return nil, false
	}
	if span == 0 {
		return nil, true
	}
	return ts(srv.now().Add(span)), true
}

func (srv *Server) notifyShare(userID string, link *sharedLink) {
	srv.live.send(userID, map[string]any{"type": "share", "id": link.ID, "expiresAt": link.ExpiresAt, "expired": srv.expired(link), "stopped": link.Stopped})
}

// itemLink: the live link of an item that is still on, from any device of the person (FR-035).
func (srv *Server) itemLink(w http.ResponseWriter, r *http.Request, s *Session) {
	item := r.URL.Query().Get("item")
	// without an item: every link of the person, with its deadline, the expired ones last (spec 007, FR-041)
	if item == "" {
		srv.allLinks(w, s)
		return
	}
	link, err := scanLink(srv.db.QueryRow(`SELECT `+linkColumns+` FROM shared_links WHERE user_id = ? AND item_id = ? AND live = 1 AND stopped_at IS NULL ORDER BY created_at DESC LIMIT 1`, s.User.ID, item))
	if errors.Is(err, sql.ErrNoRows) {
		fail(w, http.StatusNotFound, "no_link", nil)
		return
	}
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	root, _ := findRow(srv.db, s.User.ID, item)
	title := ""
	if root != nil {
		title = root.Name
	}
	writeJSON(w, http.StatusOK, srv.linkOut(link, kindOf(link.ItemKind, root), title))
}

// createLink: the link of an item kept in the App, made in an instant; sharing it again gives the same link while it is on.
func (srv *Server) createLink(w http.ResponseWriter, r *http.Request, s *Session) {
	var body struct {
		Item      string   `json:"item"`
		Kind      string   `json:"kind"`
		WithExams bool     `json:"withExams"`
		Artifacts []string `json:"artifacts"`
		ExpiresIn string   `json:"expiresIn"`
	}
	if !readJSON(r, &body) || (body.Kind != "entrada" && body.Kind != "file" && body.Kind != "folder") {
		fail(w, http.StatusBadRequest, "invalid_body", nil)
		return
	}
	expiresAt, ok := srv.expiryFrom(body.ExpiresIn)
	if !ok {
		fail(w, http.StatusBadRequest, "invalid_expires", nil)
		return
	}
	root, err := findRow(srv.db, s.User.ID, body.Item)
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	if root == nil || root.RemovedAt != nil || root.TrashedAt != nil {
		fail(w, http.StatusNotFound, "not_found", nil)
		return
	}
	if (body.Kind == "folder") != (root.ItemKind == "folder") {
		fail(w, http.StatusUnprocessableEntity, "wrong_kind", nil)
		return
	}
	if root.ItemKind == "file" && (root.Place == nil || *root.Place != "app") {
		fail(w, http.StatusUnprocessableEntity, "not_in_app", nil)
		return
	}
	kind := kindOf(root.ItemKind, root)
	link, err := scanLink(srv.db.QueryRow(`SELECT `+linkColumns+` FROM shared_links WHERE user_id = ? AND item_id = ? AND live = 1 AND stopped_at IS NULL ORDER BY created_at DESC LIMIT 1`, s.User.ID, root.ID))
	if err == nil {
		writeJSON(w, http.StatusOK, srv.linkOut(link, kind, root.Name))
		return
	}
	if !errors.Is(err, sql.ErrNoRows) {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	// an entrada goes with its exam and its maps, as the link of before (FR-066); a note or a folder, with what the person chose
	withExams, artifacts := body.WithExams, []string{}
	for _, kind := range body.Artifacts {
		if artifactKinds[kind] {
			artifacts = append(artifacts, kind)
		}
	}
	if kind == "entrada" {
		withExams, artifacts = true, []string{"mapa"}
	}
	chosen, _ := json.Marshal(artifacts)
	now := ts(srv.now())
	link = &sharedLink{ID: newID(), UserID: s.User.ID, ItemID: root.ID, ItemKind: root.ItemKind, WithExams: withExams, Artifacts: artifacts, CreatedAt: now, UpdatedAt: now}
	if value, ok := expiresAt.(string); ok {
		link.ExpiresAt = &value
	}
	if _, err := srv.db.Exec(`INSERT INTO shared_links (id, user_id, item_id, item_kind, title, live, with_exams, artifacts, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
		link.ID, s.User.ID, root.ID, root.ItemKind, root.Name, boolInt(withExams), string(chosen), expiresAt, now, now); err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	srv.notifyShare(s.User.ID, link)
	writeJSON(w, http.StatusCreated, srv.linkOut(link, kind, root.Name))
}

// stopLink: "Parar de compartilhar" (FR-063); the link then says the item stopped being shared.
func (srv *Server) stopLink(w http.ResponseWriter, r *http.Request, s *Session) {
	now := ts(srv.now())
	result, err := srv.db.Exec(`UPDATE shared_links SET stopped_at = COALESCE(stopped_at, ?), updated_at = ? WHERE id = ? AND user_id = ?`, now, now, r.PathValue("id"), s.User.ID)
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	if changed, _ := result.RowsAffected(); changed == 0 {
		fail(w, http.StatusNotFound, "not_found", nil)
		return
	}
	srv.live.send(s.User.ID, map[string]any{"type": "share", "id": r.PathValue("id"), "stopped": true})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// patchLink: "Mudar prazo" (spec 007, FR-033), counting from now, on the same address; an expired link opens again.
func (srv *Server) patchLink(w http.ResponseWriter, r *http.Request, s *Session) {
	var body struct {
		ExpiresIn string `json:"expiresIn"`
	}
	if !readJSON(r, &body) {
		fail(w, http.StatusBadRequest, "invalid_body", nil)
		return
	}
	expiresAt, ok := srv.expiryFrom(body.ExpiresIn)
	if !ok || body.ExpiresIn == "" {
		fail(w, http.StatusBadRequest, "invalid_expires", nil)
		return
	}
	link, err := scanLink(srv.db.QueryRow(`SELECT `+linkColumns+` FROM shared_links WHERE id = ? AND user_id = ? AND live = 1`, r.PathValue("id"), s.User.ID))
	if errors.Is(err, sql.ErrNoRows) {
		fail(w, http.StatusNotFound, "not_found", nil)
		return
	}
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	if link.Stopped {
		fail(w, http.StatusConflict, "stopped", nil)
		return
	}
	now := ts(srv.now())
	if _, err := srv.db.Exec(`UPDATE shared_links SET expires_at = ?, updated_at = ? WHERE id = ?`, expiresAt, now, link.ID); err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	link.UpdatedAt, link.ExpiresAt = now, nil
	if value, ok := expiresAt.(string); ok {
		link.ExpiresAt = &value
	}
	srv.notifyShare(s.User.ID, link)
	root, _ := findRow(srv.db, s.User.ID, link.ItemID)
	title := ""
	if root != nil {
		title = root.Name
	}
	writeJSON(w, http.StatusOK, srv.linkOut(link, kindOf(link.ItemKind, root), title))
}

// allLinks: every link of the person (not the stopped ones), the ones still on first, the newest first.
func (srv *Server) allLinks(w http.ResponseWriter, s *Session) {
	rows, err := srv.db.Query(`SELECT `+linkColumns+`, title FROM shared_links WHERE user_id = ? AND live = 1 AND stopped_at IS NULL ORDER BY created_at DESC`, s.User.ID)
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	type entry struct {
		link  *sharedLink
		title string
	}
	var on, off []entry
	for rows.Next() {
		var link sharedLink
		var withExams int
		var artifacts, title string
		var expires sql.NullString
		if rows.Scan(&link.ID, &link.UserID, &link.ItemID, &link.ItemKind, &withExams, &artifacts, &link.CreatedAt, &link.Stopped, &expires, &link.UpdatedAt, &title) != nil {
			continue
		}
		link.WithExams = withExams == 1
		_ = json.Unmarshal([]byte(artifacts), &link.Artifacts)
		if expires.Valid {
			link.ExpiresAt = &expires.String
		}
		if srv.expired(&link) {
			off = append(off, entry{&link, title})
		} else {
			on = append(on, entry{&link, title})
		}
	}
	rows.Close()
	out := []map[string]any{}
	for _, item := range append(on, off...) {
		root, _ := findRow(srv.db, s.User.ID, item.link.ItemID)
		title := item.title
		if root != nil {
			title = root.Name
		}
		out = append(out, srv.linkOut(item.link, kindOf(item.link.ItemKind, root), title))
	}
	writeJSON(w, http.StatusOK, map[string]any{"links": out})
}

// openLink is the link that is still on, or the refusal to answer.
func (srv *Server) openLink(w http.ResponseWriter, id string) *sharedLink {
	link, err := scanLink(srv.db.QueryRow(`SELECT `+linkColumns+` FROM shared_links WHERE id = ? AND live = 1`, id))
	switch {
	case errors.Is(err, sql.ErrNoRows):
		fail(w, http.StatusNotFound, errNoLinkRow.Error(), nil)
	case err != nil:
		fail(w, http.StatusInternalServerError, "internal_error", nil)
	case link.Stopped:
		fail(w, http.StatusGone, "share_stopped", nil)
	case srv.expired(link):
		// spec 007 (FR-035): an expired link shows nothing of the item, to people nor to agents, the media included
		fail(w, http.StatusGone, "link_expired", nil)
	default:
		return link
	}
	return nil
}

func (srv *Server) liveRows(where string, args ...any) ([]*libraryRow, error) {
	rows, err := srv.db.Query(`SELECT `+rowColumns+` FROM library_items WHERE `+where+` AND removed_at IS NULL AND trashed_at IS NULL ORDER BY position, created_at, id`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*libraryRow{}
	for rows.Next() {
		row, err := scanRow(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// family is what the link carries now: the folders (a folder link) and the notes kept in the App. Notes born later come in, the ones
// in the Lixeira or moved away go out (FR-036). A note in the Google Drive has no content here and stays out, with what was born of it.
func (srv *Server) family(link *sharedLink) (root *libraryRow, folders, files []*libraryRow, err error) {
	root, err = findRow(srv.db, link.UserID, link.ItemID)
	if err != nil {
		return nil, nil, nil, err
	}
	if root == nil || root.RemovedAt != nil || root.TrashedAt != nil {
		return nil, nil, nil, errLinkGone
	}
	inApp := func(row *libraryRow) bool { return row.Place != nil && *row.Place == "app" }
	switch kindOf(link.ItemKind, root) {
	case "file":
		if !inApp(root) {
			return nil, nil, nil, errNotInApp
		}
		return root, nil, []*libraryRow{root}, nil
	case "entrada":
		if !inApp(root) {
			return nil, nil, nil, errNotInApp
		}
		files = []*libraryRow{root}
		seen := map[string]bool{root.ID: true}
		for next := 0; next < len(files); next++ {
			children, err := srv.liveRows(`user_id = ? AND parent_file_id = ? AND item_kind = 'file'`, link.UserID, files[next].ID)
			if err != nil {
				return nil, nil, nil, err
			}
			for _, child := range children {
				if !seen[child.ID] && inApp(child) {
					seen[child.ID] = true
					files = append(files, child)
				}
			}
		}
		return root, nil, files, nil
	}
	folders = []*libraryRow{root}
	seen := map[string]bool{root.ID: true}
	for next := 0; next < len(folders); next++ {
		inside, err := srv.liveRows(`user_id = ? AND folder_id = ?`, link.UserID, folders[next].ID)
		if err != nil {
			return nil, nil, nil, err
		}
		for _, row := range inside {
			switch {
			case row.ItemKind == "folder" && !seen[row.ID]:
				seen[row.ID] = true
				folders = append(folders, row)
			case row.ItemKind == "file" && inApp(row):
				files = append(files, row)
			}
		}
	}
	return root, folders, files, nil
}

func (srv *Server) familyRefusal(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errLinkGone):
		fail(w, http.StatusGone, "item_removed", nil)
	case errors.Is(err, errNotInApp):
		fail(w, http.StatusGone, "not_in_app", nil)
	default:
		fail(w, http.StatusInternalServerError, "internal_error", nil)
	}
}

// pick keeps only the given fields of a JSON object.
func pick(raw []byte, keys ...string) map[string]json.RawMessage {
	all := map[string]json.RawMessage{}
	_ = json.Unmarshal(raw, &all)
	out := map[string]json.RawMessage{}
	for _, key := range keys {
		if value, ok := all[key]; ok {
			out[key] = value
		}
	}
	return out
}

// mapList keeps only the given fields of each object of a JSON list.
func mapList(raw json.RawMessage, keys ...string) []map[string]json.RawMessage {
	var list []json.RawMessage
	_ = json.Unmarshal(raw, &list)
	out := []map[string]json.RawMessage{}
	for _, item := range list {
		out = append(out, pick(item, keys...))
	}
	return out
}

func marshal(value any) string {
	out, _ := json.Marshal(value)
	return string(out)
}

// sharedPart is what of a part goes in the link, or false when it stays home: never the sharer's attempts, the conversation or
// versions of a map, the review progress of the cards, nor an artifact type the link does not carry.
func sharedPart(link *sharedLink, part string, content []byte) (string, bool) {
	chosen := map[string]bool{}
	for _, kind := range link.Artifacts {
		chosen[kind] = true
	}
	switch {
	case part == "text" || part == "transcript" || part == "highlights":
		return string(content), true
	case part == "exam":
		if !link.WithExams {
			return "", false
		}
		exam := pick(content, "questions")
		exam["attempts"] = json.RawMessage("[]")
		return marshal(exam), true
	case part == "documents":
		keys := []string{"documents"}
		if chosen["cartoes"] {
			keys = append(keys, "cards")
		}
		if chosen["mapa"] {
			keys = append(keys, "mindmap")
		}
		return marshal(pick(content, keys...)), true
	case strings.HasPrefix(part, "artifacts/"):
		var head struct {
			Kind string `json:"kind"`
		}
		if json.Unmarshal(content, &head) != nil || !chosen[head.Kind] {
			return "", false
		}
		base := []string{"id", "kind", "name", "createdAt", "updatedAt"}
		switch head.Kind {
		case "mapa":
			return marshal(pick(content, append(base, "diagram")...)), true
		case "cartoes":
			out := pick(content, base...)
			out["cards"], _ = json.Marshal(mapList(pick(content, "cards")["cards"], "id", "front", "back"))
			return marshal(out), true
		default:
			out := pick(content, base...)
			out["turns"], _ = json.Marshal(mapList(pick(content, "turns")["turns"], "who", "text"))
			return marshal(out), true
		}
	}
	return "", false
}

type sharedMediaOut struct {
	Mime  string `json:"mime"`
	Bytes int64  `json:"bytes"`
}

type sharedFileOut struct {
	ID           string            `json:"id"`
	NoteType     *string           `json:"noteType"`
	Name         string            `json:"name"`
	FolderID     *string           `json:"folderId"`
	ParentFileID *string           `json:"parentFileId"`
	Position     float64           `json:"position"`
	Meta         json.RawMessage   `json:"meta"`
	CreatedAt    string            `json:"createdAt"`
	UpdatedAt    string            `json:"updatedAt"`
	Parts        map[string]string `json:"parts"`
	Media        *sharedMediaOut   `json:"media"`
}

type sharedFolderOut struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	ParentID  *string         `json:"parentId"`
	Position  float64         `json:"position"`
	Meta      json.RawMessage `json:"meta"`
	CreatedAt string          `json:"createdAt"`
	UpdatedAt string          `json:"updatedAt"`
}

// sharedContent: the link as it is now, for anyone who has it, without a session (FR-036, FR-037).
func (srv *Server) sharedContent(w http.ResponseWriter, r *http.Request, _ *Session) {
	link := srv.openLink(w, r.PathValue("id"))
	if link == nil {
		return
	}
	body, err := srv.sharedBody(r.Context(), link)
	if err != nil {
		srv.familyRefusal(w, err)
		return
	}
	writeJSON(w, http.StatusOK, body)
}

// sharedBody is the content of a link as it is now: the link, its owner, its folders and notes with their parts and media (spec 007: the
// JSON, the Markdown and the page for agents are made of it).
func (srv *Server) sharedBody(ctx context.Context, link *sharedLink) (map[string]any, error) {
	root, folders, files, err := srv.family(link)
	if err != nil {
		return nil, err
	}
	var owner sql.NullString
	_ = srv.db.QueryRow(`SELECT name FROM user WHERE id = ?`, link.UserID).Scan(&owner)
	outFolders := []sharedFolderOut{}
	for _, folder := range folders {
		parent := folder.FolderID
		if folder.ID == root.ID {
			parent = nil
		}
		outFolders = append(outFolders, sharedFolderOut{ID: folder.ID, Name: folder.Name, ParentID: parent, Position: folder.Position, Meta: folder.Meta, CreatedAt: folder.CreatedAt, UpdatedAt: folder.UpdatedAt})
	}
	outFiles := []sharedFileOut{}
	for _, file := range files {
		parts := map[string]string{}
		for part, version := range file.Parts {
			reader, _, err := srv.cfg.Blobs.Get(ctx, partKey(link.UserID, file.ID, part, version), nil)
			if err != nil {
				continue
			}
			content, err := io.ReadAll(reader)
			reader.Close()
			if err != nil {
				continue
			}
			if kept, ok := sharedPart(link, part, content); ok {
				parts[part] = kept
			}
		}
		out := sharedFileOut{ID: file.ID, NoteType: file.NoteType, Name: file.Name, FolderID: file.FolderID, ParentFileID: file.ParentFileID, Position: file.Position, Meta: file.Meta, CreatedAt: file.CreatedAt, UpdatedAt: file.UpdatedAt, Parts: parts}
		if file.Media != nil && file.Media.Status == "stored" {
			size := file.Media.Bytes
			if size == 0 {
				size = file.MediaBytes
			}
			out.Media = &sharedMediaOut{Mime: file.Media.Mime, Bytes: size}
		}
		outFiles = append(outFiles, out)
	}
	body := srv.linkOut(link, kindOf(link.ItemKind, root), root.Name)
	body["owner"] = map[string]any{"name": owner.String}
	body["folders"] = outFolders
	body["files"] = outFiles
	return body, nil
}

// sharedMedia: the media of a note of the link, streamed from the App in parts, without a session; nothing is copied (FR-034).
func (srv *Server) sharedMedia(w http.ResponseWriter, r *http.Request, _ *Session) {
	link := srv.openLink(w, r.PathValue("id"))
	if link == nil {
		return
	}
	_, _, files, err := srv.family(link)
	if err != nil {
		srv.familyRefusal(w, err)
		return
	}
	for _, file := range files {
		if file.ID == r.PathValue("item") && file.Media != nil {
			srv.streamMedia(w, r, link.UserID, file)
			return
		}
	}
	fail(w, http.StatusNotFound, "not_found", nil)
}
