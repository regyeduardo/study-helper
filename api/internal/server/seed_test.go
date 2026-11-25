package server

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// The test library for the measures (spec 007, T004, research R1): seeded in a test account only, through the same routes the app
// uses, so the notes open in the app exactly as real ones.

func seedSmall() SeedOptions {
	// the harness sends uploads in parts of 4 bytes: a short media keeps it under the 10,000 parts of an upload
	return SeedOptions{Email: "teste-perf@local", Password: "senha-de-teste-1", Folders: 5, Notes: 30, Transcripts: 4, TranscriptMinutes: 60, Media: 3,
		MediaContent: []byte("midia-curta-de-teste-0123456789"), MediaMime: "audio/webm"}
}

func TestSeedFillsTheTestAccount(t *testing.T) {
	h := newHarness(t)
	report, err := h.srv.Seed(context.Background(), seedSmall())
	if err != nil {
		t.Fatal(err)
	}
	if report.Folders != 5 || report.Notes != 30 || report.Transcripts != 4 || report.Media != 3 {
		t.Fatalf("report %+v", report)
	}
	var folders, files, recordings, withMedia int
	if err := h.db.QueryRow(`SELECT COUNT(*) FROM library_items WHERE user_id = ? AND item_kind = 'folder'`, report.UserID).Scan(&folders); err != nil {
		t.Fatal(err)
	}
	_ = h.db.QueryRow(`SELECT COUNT(*) FROM library_items WHERE user_id = ? AND item_kind = 'file'`, report.UserID).Scan(&files)
	_ = h.db.QueryRow(`SELECT COUNT(*) FROM library_items WHERE user_id = ? AND recording = 1`, report.UserID).Scan(&recordings)
	_ = h.db.QueryRow(`SELECT COUNT(*) FROM library_items WHERE user_id = ? AND media IS NOT NULL`, report.UserID).Scan(&withMedia)
	if folders != 5 || files != 30+4+3 || recordings != 4 || withMedia != 3 {
		t.Fatalf("folders %d files %d recordings %d media %d", folders, files, recordings, withMedia)
	}
	// the biggest folder holds every text note: "abrir uma pasta com 1.000 notas" in the full seed
	var inBig int
	_ = h.db.QueryRow(`SELECT COUNT(*) FROM library_items WHERE user_id = ? AND folder_id = ? AND item_kind = 'file'`, report.UserID, report.BigFolderID).Scan(&inBig)
	if inBig != 30 {
		t.Fatalf("big folder has %d notes", inBig)
	}
	// the account is ready to use: structure on, hierarchy done, and it signs in with its password
	var status string
	var appEnabled int
	var hierarchyAt *string
	_ = h.db.QueryRow(`SELECT status, app_enabled, hierarchy_at FROM user WHERE id = ?`, report.UserID).Scan(&status, &appEnabled, &hierarchyAt)
	if status != "enabled" || appEnabled != 1 || hierarchyAt == nil {
		t.Fatalf("account %s %d %v", status, appEnabled, hierarchyAt)
	}
	client := h.browser()
	if res, body := h.do(client, call{method: http.MethodPost, path: "/v1/auth/password/login", body: map[string]any{"email": "teste-perf@local", "password": "senha-de-teste-1"}}); res.StatusCode != 200 {
		t.Fatalf("login %d %v", res.StatusCode, body)
	}
	// a transcript of 1 hour with 4 voices, read back through the API as the app reads it
	res, body := h.do(client, call{path: "/v1/library/map"})
	if res.StatusCode != 200 {
		t.Fatalf("map %d", res.StatusCode)
	}
	var transcriptID, version string
	for _, item := range body["rows"].([]any) {
		row := item.(map[string]any)
		if row["recording"] == true {
			transcriptID = row["id"].(string)
			version = row["parts"].(map[string]any)["transcript"].(string)
			break
		}
	}
	if transcriptID == "" {
		t.Fatal("no recording in the map")
	}
	partRes, raw := h.raw(client, http.MethodGet, "/v1/library/items/"+transcriptID+"/parts/transcript?version="+version, nil, nil)
	if partRes.StatusCode != 200 {
		t.Fatalf("part %d %s", partRes.StatusCode, raw)
	}
	content := string(raw)
	var transcript struct {
		Recording struct {
			Blocks []struct {
				Speaker string  `json:"speaker"`
				End     float64 `json:"end"`
			} `json:"blocks"`
			Speakers []struct{ Name string } `json:"speakers"`
		} `json:"recording"`
		Transcript string `json:"transcript"`
	}
	if err := json.Unmarshal([]byte(content), &transcript); err != nil {
		t.Fatalf("transcript: %v %.80s", err, content)
	}
	blocks := transcript.Recording.Blocks
	if len(transcript.Recording.Speakers) != 4 || len(blocks) < 300 || blocks[len(blocks)-1].End < 3500 || transcript.Transcript == "" {
		t.Fatalf("speakers %d blocks %d end %v", len(transcript.Recording.Speakers), len(blocks), blocks[len(blocks)-1].End)
	}
}

func TestSeedRefusesARealAccount(t *testing.T) {
	h := newHarness(t)
	options := seedSmall()
	options.Email = "ana@exemplo.com"
	if _, err := h.srv.Seed(context.Background(), options); err == nil || !strings.Contains(err.Error(), ".local") {
		t.Fatalf("seeded a real account: %v", err)
	}
	for _, email := range []string{"ana@local.com.br", "ana@notlocal", "local"} {
		options.Email = email
		if _, err := h.srv.Seed(context.Background(), options); err == nil {
			t.Fatalf("seeded %s", email)
		}
	}
	var count int
	_ = h.db.QueryRow(`SELECT COUNT(*) FROM user`).Scan(&count)
	if count != 0 {
		t.Fatalf("%d accounts made", count)
	}
	// the e-mail of the fake Google of the end-to-end tests is a test one
	options.Email = "pessoa@teste.local"
	if _, err := h.srv.Seed(context.Background(), options); err != nil {
		t.Fatal(err)
	}
}

func TestSeedTwiceNeedsRedo(t *testing.T) {
	h := newHarness(t)
	if _, err := h.srv.Seed(context.Background(), seedSmall()); err != nil {
		t.Fatal(err)
	}
	if _, err := h.srv.Seed(context.Background(), seedSmall()); err == nil {
		t.Fatal("seeded the same account twice without --refazer")
	}
	options := seedSmall()
	options.Redo = true
	report, err := h.srv.Seed(context.Background(), options)
	if err != nil {
		t.Fatal(err)
	}
	var files int
	_ = h.db.QueryRow(`SELECT COUNT(*) FROM library_items WHERE user_id = ? AND item_kind = 'file'`, report.UserID).Scan(&files)
	if files != 37 {
		t.Fatalf("after redo, %d notes", files)
	}
}

func TestSeedFillsTheSpace(t *testing.T) {
	h := newHarness(t)
	options := seedSmall()
	options.Fill = 9_500_000_000
	report, err := h.srv.Seed(context.Background(), options)
	if err != nil {
		t.Fatal(err)
	}
	var media int64
	_ = h.db.QueryRow(`SELECT media_bytes FROM user WHERE id = ?`, report.UserID).Scan(&media)
	if media < 9_500_000_000 || report.FilledBytes < 9_500_000_000 {
		t.Fatalf("media %d filled %d", media, report.FilledBytes)
	}
	var sum int64
	_ = h.db.QueryRow(`SELECT COALESCE(SUM(media_bytes), 0) FROM library_items WHERE user_id = ?`, report.UserID).Scan(&sum)
	if sum != media {
		t.Fatalf("rows %d user %d: the space check would disagree", sum, media)
	}
}
