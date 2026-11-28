package transcribe

import (
	"context"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// T205: a video brought from outside (no marks): each moment is a frame the ffmpeg of the server takes, one at a time, as the browser
// takes it (at most 1280 px wide, JPEG; the gray signature of 48×36 that tells two screens apart).
func TestTheFramesOfAVideoComeFromTheFFmpegOfTheServer(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("sem ffmpeg nesta máquina")
	}
	dir := t.TempDir()
	video := filepath.Join(dir, "aula.webm")
	// 3 s of red, then 3 s of white, at 1920×1080
	if out, err := exec.Command("ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=1920x1080:d=3:r=5", "-f", "lavfi", "-i", "color=c=white:s=1920x1080:d=3:r=5",
		"-filter_complex", "[0:v][1:v]concat=n=2:v=1[v]", "-map", "[v]", "-c:v", "libvpx", "-b:v", "200k", video).CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg: %v %s", err, out)
	}
	screens := VideoScreens{FFmpeg: "ffmpeg", Media: video}
	shots, err := screens.Shots(context.Background(), []float64{1, 1.5, 4.5})
	if err != nil || len(shots) != 3 {
		t.Fatalf("%v %d", err, len(shots))
	}
	for _, at := range []float64{1, 1.5, 4.5} {
		if !strings.HasPrefix(shots[at].Image, "data:image/jpeg;base64,") || len(shots[at].Signature) != 48*36 {
			t.Fatalf("%v: %q… %d", at, shots[at].Image[:min(30, len(shots[at].Image))], len(shots[at].Signature))
		}
	}
	if signatureDistance(shots[1].Signature, shots[1.5].Signature) >= sameScreen || signatureDistance(shots[1].Signature, shots[4.5].Signature) < sameScreen {
		t.Fatalf("same %v, other %v", signatureDistance(shots[1].Signature, shots[1.5].Signature), signatureDistance(shots[1].Signature, shots[4.5].Signature))
	}
	// red is gray 85, white 255, as the browser averages the channels
	if gray := shots[1].Signature[100]; gray < 80 || gray > 90 {
		t.Fatalf("red %v", gray)
	}
	if gray := shots[4.5].Signature[100]; gray < 250 {
		t.Fatalf("white %v", gray)
	}
	// a video that is not one says why
	if _, err := (VideoScreens{FFmpeg: "ffmpeg", Media: filepath.Join(dir, "nada.webm")}).Shots(context.Background(), []float64{1}); err == nil {
		t.Fatal("no error")
	}
}
