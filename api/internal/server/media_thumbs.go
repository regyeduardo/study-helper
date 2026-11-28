package server

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// T197 (dono, 27/11: "Por que está passando ffmpeg no navegador ao invés do servidor?"): the gray thumbnails of the whole video for the
// index of the screens (src/lib/generation/scene-index.ts). The job's Chromium decoded the whole video for them (20 min for the 90 min
// recording of 27/11, jumping; a pass of WebCodecs was 66 s for 20 min of 1080p on 2 cores); ffmpeg reads the media where it is kept,
// once, in 45 s for the same video, outside the Chromium's memory. One at a time: the server has 2 vCPU, and the media lane runs one
// job at a time anyway (T190).

const (
	thumbsMaxCount = 2400
	thumbsMaxSide  = 640
	thumbsMinStep  = 0.5
	// a 90 min recording took 403 s on the server's Xeon (measured 27/11): plenty of room, never forever
	thumbsMaxRun = 30 * time.Minute
)

// thumbsDiskReserve is what the copy of the media leaves free on the disk, at least: the database lives on the same disk (24 GB on the
// server, 12 GB free on 27/11), and an account may keep 10 GiB of media.
var thumbsDiskReserve int64 = 3 << 30

func newThumbsGate() chan struct{} { return make(chan struct{}, 1) }

// freeBytes is the room left on the disk of dir; false when it cannot tell.
func freeBytes(dir string) (int64, bool) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(dir, &stat); err != nil {
		return 0, false
	}
	return int64(stat.Bavail) * int64(stat.Bsize), true
}

func (srv *Server) ffmpegPath() string {
	if srv.cfg.FFmpegPath != "" {
		return srv.cfg.FFmpegPath
	}
	return "ffmpeg"
}

// averageGray makes red, green and blue their mean, the gray of the browser's thumbnails (grayOf in video-source.ts), not the video's
// own brightness (green would be 150 instead of 85).
const averageGray = "colorchannelmixer=rr=0.3333:rg=0.3334:rb=0.3333:gr=0.3333:gg=0.3334:gb=0.3333:br=0.3333:bg=0.3334:bb=0.3333"

// thumbsArgs: from `from` seconds, one frame every `step` seconds, `count` of them, scaled to w×h, one gray byte per pixel in full range
// (0 to 255, as the browser draws the video: a "tv" range video would give 16 to 235), back to back, made as the browser makes them, so
// the index of the screens comes out the same (measured on the 90 min recording of 27/11, against the browser's 134 screens: 99 found
// with ffmpeg's plain fps and scale, 130 like this):
//   - each one is the frame shown at its time on the video's own clock, as the browser's pass gives it (the plain fps filter took the
//     one up to half a step later);
//   - drawn as the canvas draws it (Skia): from the mipmap level of the larger reduction, the mean of 2^n × 2^n pixels, then bilinear.
func thumbsArgs(input string, from, step float64, count, w, h int) []string {
	number := func(value float64) string { return strconv.FormatFloat(value, 'f', -1, 64) }
	width, height := strconv.Itoa(w), strconv.Itoa(h)
	level := "max(0,floor(log(max(iw/" + width + ",ih/" + height + "))/log(2)+0.000001))"
	return []string{"-nostdin", "-loglevel", "error", "-copyts", "-noaccurate_seek", "-ss", number(from), "-i", input, "-an", "-sn", "-dn",
		"-vf", "fps=fps=1/" + number(step) + ":start_time=" + number(from) + ":round=up,format=rgb24," +
			"scale=w='trunc(iw/pow(2," + level + "))':h='trunc(ih/pow(2," + level + "))':flags=area," +
			"scale=" + width + ":" + height + ":flags=fast_bilinear," + averageGray + ",format=gray",
		"-frames:v", strconv.Itoa(count), "-f", "rawvideo", "pipe:1"}
}

// mediaThumbs answers GET /v1/media/{item}/{media}/thumbs?from=1&step=4.5&count=1210&w=256&h=144: the frames back to back
// (X-Frame-Bytes each), fewer when the video ends first. A media ffmpeg cannot read is refused (422), never an empty answer.
func (srv *Server) mediaThumbs(w http.ResponseWriter, r *http.Request, s *Session) {
	row, err := findRow(srv.db, s.User.ID, r.PathValue("item"))
	if err != nil || row == nil || row.RemovedAt != nil || row.Media == nil || row.Media.ID != r.PathValue("media") {
		fail(w, http.StatusNotFound, "not_found", nil)
		return
	}
	switch row.Media.Status {
	case "deleted":
		fail(w, http.StatusGone, "media_deleted", nil)
		return
	case "stored":
	default:
		fail(w, http.StatusNotFound, "not_found", nil)
		return
	}
	query := r.URL.Query()
	from, errFrom := strconv.ParseFloat(query.Get("from"), 64)
	step, errStep := strconv.ParseFloat(query.Get("step"), 64)
	count, errCount := strconv.Atoi(query.Get("count"))
	width, errWidth := strconv.Atoi(query.Get("w"))
	height, errHeight := strconv.Atoi(query.Get("h"))
	if errFrom != nil || errStep != nil || errCount != nil || errWidth != nil || errHeight != nil || from < 0 || step < thumbsMinStep || count < 1 || count > thumbsMaxCount ||
		width < 8 || height < 8 || width > thumbsMaxSide || height > thumbsMaxSide {
		fail(w, http.StatusBadRequest, "invalid_query", nil)
		return
	}
	select {
	case srv.thumbsGate <- struct{}{}:
		defer func() { <-srv.thumbsGate }()
	case <-r.Context().Done():
		return
	}
	// a copy that would leave the disk short is refused before it starts (the app uses the browser's pass instead)
	if free, ok := freeBytes(os.TempDir()); ok && free-row.Media.Bytes < thumbsDiskReserve {
		srv.logf("thumbs: %s: no room for %d bytes (%d free)", r.PathValue("item"), row.Media.Bytes, free)
		fail(w, http.StatusInsufficientStorage, "no_room", nil)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), thumbsMaxRun)
	defer cancel()
	// ffmpeg jumps to `from` and reads in order: the media goes to a file of its own (an MP4 with its index at the end needs to jump)
	input, err := srv.mediaFile(ctx, row.Media.Key)
	if err != nil {
		fail(w, http.StatusBadGateway, "storage_failed", nil)
		return
	}
	defer os.Remove(input)
	cmd := exec.CommandContext(ctx, srv.ffmpegPath(), thumbsArgs(input, from, step, count, width, height)...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	var stderr limitedBuffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		fail(w, http.StatusServiceUnavailable, "ffmpeg_unavailable", nil)
		return
	}
	frame := width * height
	first := make([]byte, frame)
	if _, err := io.ReadFull(stdout, first); err != nil {
		_ = cmd.Wait()
		srv.logf("thumbs: %s: %s", r.PathValue("item"), strings.TrimSpace(stderr.String()))
		fail(w, http.StatusUnprocessableEntity, "media_unreadable", nil)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "application/octet-stream")
	h.Set("Cache-Control", "private, no-store")
	h.Set("X-Frame-Bytes", strconv.Itoa(frame))
	h.Set("Access-Control-Expose-Headers", "X-Frame-Bytes")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(first)
	flusher, _ := w.(http.Flusher)
	buffer := make([]byte, frame)
	for {
		n, readErr := io.ReadFull(stdout, buffer)
		if n > 0 {
			if _, err := w.Write(buffer[:n]); err != nil {
				cancel()
				break
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if readErr != nil {
			break
		}
	}
	if err := cmd.Wait(); err != nil && ctx.Err() == nil {
		srv.logf("thumbs: %s: %v %s", r.PathValue("item"), err, strings.TrimSpace(stderr.String()))
	}
}

// mediaFile copies the media kept under `key` to a file of its own (the caller removes it).
func (srv *Server) mediaFile(ctx context.Context, key string) (string, error) {
	reader, _, err := srv.cfg.Blobs.Get(ctx, key, nil)
	if err != nil {
		return "", err
	}
	defer reader.Close()
	file, err := os.CreateTemp("", "estudo-midia-*")
	if err != nil {
		return "", err
	}
	if _, err := io.Copy(file, reader); err != nil {
		file.Close()
		os.Remove(file.Name())
		return "", err
	}
	if err := file.Close(); err != nil {
		os.Remove(file.Name())
		return "", err
	}
	return file.Name(), nil
}

// limitedBuffer keeps the first 4 KB of what ffmpeg says on stderr (for the log), never more.
type limitedBuffer struct{ bytes.Buffer }

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if room := 4096 - b.Len(); room > 0 {
		if len(p) > room {
			_, _ = b.Buffer.Write(p[:room])
		} else {
			_, _ = b.Buffer.Write(p)
		}
	}
	return len(p), nil
}
