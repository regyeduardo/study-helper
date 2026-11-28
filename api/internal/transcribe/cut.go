package transcribe

import (
	"context"
	"encoding/csv"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

// Part is a piece of the audio, kept on disk, and where it starts in the recording.
type Part struct {
	Path  string
	Start float64
	End   float64
}

// Cutting is the audio of a recording cut for hearing: the parts, the whole audio (for the voice split) and how they are packed.
type Cutting struct {
	Parts []Part
	Whole string
	// Format is what the parts are, as `input_audio` names it ("ogg", "aac", "mp3").
	Format   string
	Duration float64
}

// packing: the audio codec of the recording and how its packets go into parts without decoding (R27: 1h30 in 1.7 s, 56 MB of RSS).
var packing = map[string]struct{ muxer, extension, format string }{
	"opus":   {"ogg", "ogg", "ogg"},
	"vorbis": {"ogg", "ogg", "ogg"},
	"aac":    {"adts", "aac", "aac"},
	"mp3":    {"mp3", "mp3", "mp3"},
}

// Cut splits the audio of `media` into parts of `seconds` by copying its packets (no decoding), plus the whole audio, in `dir`. An
// audio codec that cannot be copied (rare: the app records Opus) is re-encoded to Opus.
func Cut(ctx context.Context, ffmpeg, media, dir string, seconds int) (Cutting, error) {
	codec, duration, err := probe(ctx, ffmpeg, media)
	if err != nil {
		return Cutting{}, err
	}
	pack, copied := packing[codec]
	audio := []string{"-c:a", "copy"}
	if !copied {
		pack = packing["opus"]
		audio = []string{"-ac", "1", "-c:a", "libopus", "-b:a", "32k", "-application", "voip"}
	}
	parts := filepath.Join(dir, "partes")
	if err := os.MkdirAll(parts, 0o700); err != nil {
		return Cutting{}, err
	}
	list := filepath.Join(dir, "partes.csv")
	whole := filepath.Join(dir, "inteiro."+pack.extension)
	args := []string{"-nostdin", "-loglevel", "error", "-threads", "1", "-y", "-i", media, "-map", "0:a:0"}
	args = append(args, audio...)
	args = append(args, "-f", "segment", "-segment_time", strconv.Itoa(seconds), "-segment_format", pack.muxer, "-reset_timestamps", "1",
		"-segment_list", list, "-segment_list_type", "csv", filepath.Join(parts, "p%03d."+pack.extension), "-map", "0:a:0")
	args = append(args, audio...)
	args = append(args, "-f", pack.muxer, whole)
	if out, err := exec.CommandContext(ctx, ffmpeg, args...).CombinedOutput(); err != nil {
		return Cutting{}, fmt.Errorf("o áudio não foi cortado: %v %s", err, strings.TrimSpace(string(out)))
	}
	file, err := os.Open(list)
	if err != nil {
		return Cutting{}, err
	}
	defer file.Close()
	rows, err := csv.NewReader(file).ReadAll()
	if err != nil {
		return Cutting{}, err
	}
	out := Cutting{Whole: whole, Format: pack.format, Duration: duration}
	for _, row := range rows {
		if len(row) < 3 {
			continue
		}
		start, _ := strconv.ParseFloat(row[1], 64)
		end, _ := strconv.ParseFloat(row[2], 64)
		out.Parts = append(out.Parts, Part{Path: filepath.Join(parts, row[0]), Start: start, End: end})
	}
	if len(out.Parts) == 0 {
		return Cutting{}, fmt.Errorf("a gravação não tem áudio")
	}
	if out.Duration <= 0 {
		out.Duration = out.Parts[len(out.Parts)-1].End
	}
	return out, nil
}

// probe is the codec of the first audio track and the length of the media (by ffprobe, next to ffmpeg).
func probe(ctx context.Context, ffmpeg, media string) (string, float64, error) {
	ffprobe := "ffprobe"
	if dir := filepath.Dir(ffmpeg); dir != "." {
		ffprobe = filepath.Join(dir, "ffprobe")
	}
	out, err := exec.CommandContext(ctx, ffprobe, "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name:format=duration", "-of", "default=noprint_wrappers=1", media).Output()
	if err != nil {
		return "", 0, fmt.Errorf("a mídia não abriu: %v", err)
	}
	codec, duration := "", 0.0
	for _, line := range strings.Split(string(out), "\n") {
		key, value, _ := strings.Cut(strings.TrimSpace(line), "=")
		switch key {
		case "codec_name":
			codec = value
		case "duration":
			duration, _ = strconv.ParseFloat(value, 64)
		}
	}
	if codec == "" {
		return "", 0, fmt.Errorf("a gravação não tem áudio")
	}
	return codec, duration, nil
}
