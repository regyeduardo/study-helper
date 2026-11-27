package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Spec 005, FR-022 (T052; dono, 25/11: "Juntar"): the repeated names from before the rule (FR-021) are undone once, by
// cmd/juntar-nomes, which copies the database first. Folders of the same name in the same folder become one: what is inside goes to the
// oldest, the folders inside of the same name join too, and the emptied one goes to the Trash. Notes of the same name stay: the oldest
// keeps the name and the newer get " (2)", " (3)"… What is in the Trash is left alone. Each row changed gets a new rev and the same new
// seq, so every device takes the change from the map; the meta the app reads changes with the columns.

// NamesReport says what a run changed (or, simulated, would change) in one account.
type NamesReport struct {
	UserID        string   `json:"userId"`
	Email         string   `json:"email,omitempty"`
	FoldersJoined int      `json:"foldersJoined"`
	NotesRenamed  int      `json:"notesRenamed"`
	Changes       []string `json:"changes,omitempty"`
}

type repairItem struct {
	id, kind, name, folderID, createdAt string
	trashed, changed                    bool
	meta                                map[string]any
}

var numbered = regexp.MustCompile(`^(.*\S) \((\d+)\)$`)

// freeName is the name with " (2)", " (3)"… until it is free; a name that already ends in " (n)" goes on from n.
func freeName(name string, taken map[string]bool) string {
	if !taken[nameKey(name)] {
		return name
	}
	base, next := strings.TrimSpace(name), 2
	if found := numbered.FindStringSubmatch(base); found != nil {
		base = found[1]
		if n, err := strconv.Atoi(found[2]); err == nil {
			next = n + 1
		}
	}
	for taken[nameKey(fmt.Sprintf("%s (%d)", base, next))] {
		next++
	}
	return fmt.Sprintf("%s (%d)", base, next)
}

func oldestFirst(items []*repairItem) {
	sort.Slice(items, func(a, b int) bool {
		if items[a].createdAt != items[b].createdAt {
			return items[a].createdAt < items[b].createdAt
		}
		return items[a].id < items[b].id
	})
}

// groupsOf are the live items of a kind by folder and name, in a fixed order (the same run says the same).
func groupsOf(items map[string]*repairItem, kind string) [][]*repairItem {
	byKey := map[string][]*repairItem{}
	for _, item := range items {
		if item.kind == kind && !item.trashed {
			key := item.folderID + "\x00" + nameKey(item.name)
			byKey[key] = append(byKey[key], item)
		}
	}
	keys := make([]string, 0, len(byKey))
	for key := range byKey {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	out := make([][]*repairItem, 0, len(keys))
	for _, key := range keys {
		group := byKey[key]
		oldestFirst(group)
		out = append(out, group)
	}
	return out
}

// RepairNames undoes the repeated names of one account; apply false only says what it would do.
func RepairNames(ctx context.Context, db *sql.DB, now time.Time, userID string, apply bool) (NamesReport, error) {
	report := NamesReport{UserID: userID}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return report, err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `SELECT id, item_kind, name, COALESCE(folder_id, ''), created_at, meta FROM library_items
		WHERE user_id = ? AND removed_at IS NULL AND (trashed_at IS NULL OR trashed_at = '')`, userID)
	if err != nil {
		return report, err
	}
	items := map[string]*repairItem{}
	for rows.Next() {
		item := &repairItem{}
		var meta string
		if err := rows.Scan(&item.id, &item.kind, &item.name, &item.folderID, &item.createdAt, &meta); err != nil {
			rows.Close()
			return report, err
		}
		if json.Unmarshal([]byte(meta), &item.meta) != nil || item.meta == nil {
			item.meta = map[string]any{}
		}
		items[item.id] = item
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return report, err
	}
	nameOf := func(id string) string {
		if item, ok := items[id]; ok {
			return item.name
		}
		return "Biblioteca"
	}

	// folders first, until no two of the same name share a folder: joining two can bring two of the same name together inside
	for joined := true; joined; {
		joined = false
		for _, group := range groupsOf(items, "folder") {
			keep := group[0]
			for _, other := range group[1:] {
				for _, child := range items {
					if !child.trashed && child.folderID == other.id {
						child.folderID, child.changed = keep.id, true
					}
				}
				other.trashed, other.changed = true, true
				report.FoldersJoined++
				report.Changes = append(report.Changes, fmt.Sprintf("pasta %q (em %s) juntada na mais antiga de mesmo nome; a vazia foi para a Lixeira", other.name, nameOf(keep.folderID)))
				joined = true
			}
		}
	}

	// notes: the oldest keeps the name, the newer get the first free number in that folder
	taken := map[string]map[string]bool{}
	for _, item := range items {
		if item.kind == "file" && !item.trashed {
			if taken[item.folderID] == nil {
				taken[item.folderID] = map[string]bool{}
			}
			taken[item.folderID][nameKey(item.name)] = true
		}
	}
	for _, group := range groupsOf(items, "file") {
		for _, note := range group[1:] {
			name := freeName(note.name, taken[note.folderID])
			taken[note.folderID][nameKey(name)] = true
			report.Changes = append(report.Changes, fmt.Sprintf("nota %q (em %s) agora se chama %q", note.name, nameOf(note.folderID), name))
			note.name, note.changed = name, true
			report.NotesRenamed++
		}
	}

	if !apply || (report.FoldersJoined == 0 && report.NotesRenamed == 0) {
		return report, nil
	}
	seq, err := nextSeq(tx, userID)
	if err != nil {
		return report, err
	}
	at := ts(now)
	for _, item := range items {
		if !item.changed {
			continue
		}
		var folder any
		if item.folderID != "" {
			folder = item.folderID
		}
		item.meta["name"] = item.name
		if item.kind == "folder" {
			item.meta["parentId"] = folder
		} else {
			item.meta["folderId"] = folder
		}
		var trashedAt any
		if item.trashed {
			item.meta["deletedAt"] = at
			trashedAt = at
		}
		item.meta["updated"] = map[string]any{"at": at, "deviceId": "servidor", "deviceName": "Servidor (juntar nomes)"}
		meta, err := json.Marshal(item.meta)
		if err != nil {
			return report, err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE library_items SET name = ?, folder_id = ?, trashed_at = COALESCE(?, trashed_at), meta = ?, updated_at = ?, rev = rev + 1, seq = ?
			WHERE user_id = ? AND id = ?`, item.name, folder, trashedAt, string(meta), at, seq, userID, item.id); err != nil {
			return report, err
		}
	}
	return report, tx.Commit()
}

// RepairAllNames runs RepairNames on every account (or only the one with that e-mail or id).
func RepairAllNames(ctx context.Context, db *sql.DB, now time.Time, only string, apply bool) ([]NamesReport, error) {
	rows, err := db.QueryContext(ctx, `SELECT id, email FROM user WHERE ? = '' OR id = ? OR email = ? ORDER BY email`, only, only, only)
	if err != nil {
		return nil, err
	}
	type account struct{ id, email string }
	var accounts []account
	for rows.Next() {
		var one account
		if err := rows.Scan(&one.id, &one.email); err != nil {
			rows.Close()
			return nil, err
		}
		accounts = append(accounts, one)
	}
	rows.Close()
	reports := []NamesReport{}
	for _, one := range accounts {
		report, err := RepairNames(ctx, db, now, one.id, apply)
		if err != nil {
			return reports, fmt.Errorf("%s: %w", one.email, err)
		}
		report.Email = one.email
		reports = append(reports, report)
	}
	return reports, nil
}
