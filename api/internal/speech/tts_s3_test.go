package speech

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/regyeduardo/study-helper/api/internal/blobs"
)

// The model voice cached through the same S3 code that talks to R2, against a local S3 (MinIO): ESTUDO_S3_TEST=endpoint|bucket|key|secret.
// Never the production bucket. Skipped when not set (CI).
func TestSayCachesOnS3(t *testing.T) {
	parts := strings.Split(os.Getenv("ESTUDO_S3_TEST"), "|")
	if len(parts) != 4 {
		t.Skip("ESTUDO_S3_TEST not set")
	}
	store := &blobs.S3{Endpoint: parts[0], Bucket: parts[1], AccessKey: parts[2], SecretKey: parts[3], Region: "auto"}
	voice := &fakeVoice{}
	tts := &TTS{AI: voice, Blobs: store, LeadIn: func(b []byte) []byte { return b }}
	ctx := context.Background()
	first, err := tts.Say(ctx, "The voice kept in S3", "en-US", "")
	if err != nil {
		t.Fatal(err)
	}
	again, err := tts.Say(ctx, "The voice kept in S3", "en-US", "")
	if err != nil || string(again) != string(first) || len(voice.calls) != 1 {
		t.Fatalf("second time from S3, no voice call: %d calls %v", len(voice.calls), err)
	}
}
