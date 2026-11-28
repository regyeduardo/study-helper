package server

import (
	"context"
	"net/http"
	"os/exec"
	"strconv"
	"testing"
)

// T197 (dono, 27/11: "Por que está passando ffmpeg no navegador ao invés do servidor?"): the gray thumbnails of the whole video, for the
// index of the screens, come from the server's ffmpeg reading the media where it is kept, once, instead of the job's Chromium decoding it
// (measured on 2 cores: ffmpeg 45 s against 66 s for 20 min of 1080p, and nothing in the Chromium's memory).

// thumbsVideo keeps, as the video of note n1 of the account, 6 s: 2 s black, 2 s white, 2 s green (made with ffmpeg); false without ffmpeg.
func thumbsVideo(t *testing.T, h *harness, userID string) bool {
	t.Helper()
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		return false
	}
	out, err := exec.Command("ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=64x36:r=10:d=2", "-f", "lavfi", "-i", "color=c=white:s=64x36:r=10:d=2",
		"-f", "lavfi", "-i", "color=c=0x00ff00:s=64x36:r=10:d=2", "-filter_complex", "[0][1][2]concat=n=3:v=1:a=0", "-c:v", "libvpx-vp9", "-b:v", "200k", "-f", "webm", "pipe:1").Output()
	if err != nil {
		t.Fatalf("ffmpeg: %v", err)
	}
	keepMedia(t, h, userID, out)
	return true
}

func keepMedia(t *testing.T, h *harness, userID string, body []byte) {
	t.Helper()
	if err := h.blobs.Put(context.Background(), "u/"+userID+"/m/n1/m1", body, "video/webm", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := h.db.Exec(`INSERT INTO library_items (user_id, id, item_kind, note_type, name, place, position, meta, media, media_bytes, created_at, updated_at, rev, seq) VALUES (?, 'n1', 'file', 'video', 'Reunião', 'app', 0, '{}', ?, ?, '2026-11-27T10:00:00Z', '2026-11-27T10:00:00Z', 1, 1)`,
		userID, `{"id":"m1","key":"u/`+userID+`/m/n1/m1","mime":"video/webm","bytes":`+strconv.Itoa(len(body))+`,"status":"stored"}`, len(body)); err != nil {
		t.Fatal(err)
	}
}

func TestTheThumbnailsComeFromTheServersFfmpeg(t *testing.T) {
	h := newHarness(t)
	ana, anaID := h.account("enabled", true, "ana@exemplo.com")
	if !thumbsVideo(t, h, anaID) {
		t.Skip("sem ffmpeg nesta máquina")
	}
	// 1.5 s is still black and 3.5 s still white: each thumbnail is the frame shown at its time, as the browser's pass gives it (a plain
	// fps filter took the one up to half a step later, measured 27/11: on the 90 min recording the index came out other than the browser's)
	res, out := h.raw(ana, http.MethodGet, "/v1/media/n1/m1/thumbs?from=1.5&step=2&count=3&w=16&h=9", nil, map[string]string{"Origin": appOrigin})
	if res.StatusCode != 200 || res.Header.Get("X-Frame-Bytes") != "144" || len(out) != 3*144 {
		t.Fatalf("%d %v %d bytes", res.StatusCode, res.Header, len(out))
	}
	mean := func(frame []byte) int {
		total := 0
		for _, value := range frame {
			total += int(value)
		}
		return total / len(frame)
	}
	// in full range, as the browser draws them (not 16 and 235), and the gray is the browser's, the mean of red, green and blue: green is
	// 85, not the 150 of the video's own brightness
	if black, white, green := mean(out[:144]), mean(out[144:288]), mean(out[288:]); black > 8 || white < 247 || green < 75 || green > 95 {
		t.Fatalf("níveis %d %d %d", black, white, green)
	}
	if res.Header.Get("Access-Control-Allow-Origin") != appOrigin {
		t.Fatalf("the job's page reads it: %v", res.Header)
	}
	// from the middle, the times are still the video's own (white at 3.5 s, green at 5.5 s)
	if res, out := h.raw(ana, http.MethodGet, "/v1/media/n1/m1/thumbs?from=3.5&step=2&count=2&w=16&h=9", nil, nil); res.StatusCode != 200 || len(out) != 2*144 || mean(out[:144]) < 247 || mean(out[144:]) > 95 {
		t.Fatalf("do meio: %d %d bytes", res.StatusCode, len(out))
	}
}

func TestThumbnailsRefuseWhatTheyCannotDo(t *testing.T) {
	h := newHarness(t)
	ana, anaID := h.account("enabled", true, "ana@exemplo.com")
	bia, _ := h.account("enabled", true, "bia@exemplo.com")
	keepMedia(t, h, anaID, []byte("isto não é um vídeo"))
	for _, query := range []string{"from=1&step=0.1&count=3&w=16&h=9", "from=1&step=2&count=0&w=16&h=9", "from=1&step=2&count=3&w=4000&h=9", "from=-1&step=2&count=3&w=16&h=9", "step=2&count=3&w=16&h=9"} {
		if res, _ := h.raw(ana, http.MethodGet, "/v1/media/n1/m1/thumbs?"+query, nil, nil); res.StatusCode != http.StatusBadRequest {
			t.Fatalf("%s: %d", query, res.StatusCode)
		}
	}
	// another account's media is not there
	if res, _ := h.raw(bia, http.MethodGet, "/v1/media/n1/m1/thumbs?from=1&step=2&count=3&w=16&h=9", nil, nil); res.StatusCode != http.StatusNotFound {
		t.Fatalf("outra conta: %d", res.StatusCode)
	}
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("sem ffmpeg nesta máquina")
	}
	// what ffmpeg cannot read is refused, saying so, never an empty answer taken for a video without screens
	if res, body := h.do(ana, call{path: "/v1/media/n1/m1/thumbs?from=1&step=2&count=3&w=16&h=9"}); res.StatusCode != http.StatusUnprocessableEntity || body["error"] != "media_unreadable" {
		t.Fatalf("não é vídeo: %d %v", res.StatusCode, body)
	}
}

// The copy of the media goes to the same disk as the database (24 GB on the server, 12 GB free on 27/11, and an account may keep 10 GiB):
// a copy that would leave less than the reserve free is refused before it starts, and the app uses the browser's pass instead.
func TestThumbnailsNeverFillTheDisk(t *testing.T) {
	h := newHarness(t)
	ana, anaID := h.account("enabled", true, "ana@exemplo.com")
	keepMedia(t, h, anaID, []byte("qualquer mídia"))
	saved := thumbsDiskReserve
	thumbsDiskReserve = 1 << 62
	t.Cleanup(func() { thumbsDiskReserve = saved })
	if res, body := h.do(ana, call{path: "/v1/media/n1/m1/thumbs?from=1&step=2&count=3&w=16&h=9"}); res.StatusCode != http.StatusInsufficientStorage || body["error"] != "no_room" {
		t.Fatalf("sem espaço: %d %v", res.StatusCode, body)
	}
}
