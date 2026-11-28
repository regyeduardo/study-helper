package transcribe

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"image/jpeg"
	"os/exec"
	"strconv"
	"strings"
)

// T205 (research R30): the screen of a video brought from outside, without the marks of the recording: each moment is one frame the
// ffmpeg takes, one at a time (a single child process, the least memory), as the browser takes it (src/lib/generation/video-source.ts:
// the whole frame at most 1280 px wide in JPEG 0.85, and the gray signature of 48×36, the mean of the three channels).

const (
	frameWidth      = 1280
	signatureWidth  = 48
	signatureHeight = 36
)

// VideoScreens are the frames of a video on disk.
type VideoScreens struct {
	FFmpeg, Media string
}

var _ Screens = VideoScreens{}

func (v VideoScreens) shot(ctx context.Context, at float64) (Shot, error) {
	// measured on the 1h30 meeting of 27/11 (VP9 1920×1080): only the JPEG out of the ffmpeg, in one thread, is 85 MB and 0.5 s a frame;
	// the signature made by the ffmpeg too (a second output, the frame in RGB) was 155 MB and 2.2 s
	command := exec.CommandContext(ctx, v.FFmpeg, "-nostdin", "-loglevel", "error", "-threads", "1", "-ss", strconv.FormatFloat(at, 'f', 3, 64), "-i", v.Media,
		"-an", "-sn", "-dn", "-filter_threads", "1", "-vf", "scale='min("+strconv.Itoa(frameWidth)+",iw)':-2", "-frames:v", "1", "-q:v", "3", "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1")
	var errOut bytes.Buffer
	command.Stderr = &errOut
	photo, err := command.Output()
	if err != nil {
		if ctx.Err() != nil {
			return Shot{}, ctx.Err()
		}
		return Shot{}, fmt.Errorf("o quadro de %s não abriu (%s)", clockOf(at), strings.TrimSpace(firstLine(errOut.String())))
	}
	if len(photo) == 0 {
		return Shot{}, fmt.Errorf("o vídeo não tem quadro em %s", clockOf(at))
	}
	signature, err := grayOfJPEG(photo)
	if err != nil {
		return Shot{}, fmt.Errorf("o quadro de %s não abriu (%v)", clockOf(at), err)
	}
	return Shot{Image: "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(photo), Signature: signature}, nil
}

// grayOfJPEG is the signature of a frame: 48×36, each cell the mean of the three channels over its area (as the browser draws it small).
func grayOfJPEG(photo []byte) ([]float64, error) {
	picture, err := jpeg.Decode(bytes.NewReader(photo))
	if err != nil {
		return nil, err
	}
	bounds := picture.Bounds()
	width, height := bounds.Dx(), bounds.Dy()
	if width == 0 || height == 0 {
		return nil, errors.New("quadro vazio")
	}
	sums := make([]float64, signatureWidth*signatureHeight)
	counts := make([]float64, len(sums))
	for y := 0; y < height; y++ {
		row := y * signatureHeight / height * signatureWidth
		for x := 0; x < width; x++ {
			r, g, b, _ := picture.At(bounds.Min.X+x, bounds.Min.Y+y).RGBA()
			cell := row + x*signatureWidth/width
			sums[cell] += float64(r+g+b) / 3 / 257
			counts[cell]++
		}
	}
	for i := range sums {
		sums[i] /= max(1, counts[i])
	}
	return sums, nil
}

// Shots takes the frame of each moment; a moment past the end has none.
func (v VideoScreens) Shots(ctx context.Context, times []float64) (map[float64]Shot, error) {
	out := map[float64]Shot{}
	var last error
	for _, at := range times {
		shot, err := v.shot(ctx, at)
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return nil, err
		}
		if err != nil {
			last = err
			continue
		}
		out[at] = shot
	}
	if len(out) == 0 && last != nil {
		return nil, fmt.Errorf("o vídeo não deixa ler os quadros: %w", last)
	}
	return out, nil
}

// Duration is the length of the media, by ffprobe (0 when it does not say).
func Duration(ctx context.Context, ffmpeg, media string) float64 {
	_, seconds, _ := probe(ctx, ffmpeg, media)
	return seconds
}

func firstLine(text string) string {
	line, _, _ := strings.Cut(text, "\n")
	return line
}

func clockOf(seconds float64) string {
	total := int(seconds)
	return fmt.Sprintf("%02d:%02d:%02d", total/3600, total%3600/60, total%60)
}
