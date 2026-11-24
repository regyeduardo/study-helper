package langs

import (
	"context"
	"os"
	"testing"

	"github.com/regyeduardo/study-helper/api/internal/blobs"
)

// The cache through the same S3 code that talks to R2, against a local S3 (MinIO): run with ESTUDO_S3_TEST=endpoint|bucket|key|secret.
// Never the production bucket. Skipped when not set (CI).
func TestCacheOnS3(t *testing.T) {
	store := s3ForTest(t)
	cache := &ItemCache{Blobs: store}
	ctx := context.Background()
	content := loadOK(t)
	Repair(&content, nil)
	for n, id := range content.Items.Keys {
		if err := cache.Put(ctx, "en", CachedItem{ID: id, Item: content.Items.ByID[id], Model: "m", Version: n + 1, At: "2026-11-23T00:00:00.000Z"}); err != nil {
			t.Fatal(err)
		}
	}
	walk, err := cache.Get(ctx, "en", "walk")
	if err != nil || walk.Item.Meaning != "andar, caminhar" || len(walk.Item.Test) != 2 || walk.Item.Test[0].ID != "walk__1" {
		t.Fatalf("back from S3: %+v %v", walk, err)
	}
	index := cache.Index(ctx, "en")
	if len(index) != len(content.Items.Keys) {
		t.Fatalf("index: %+v", index)
	}
	// a new version replaces the old
	walk.Version, walk.Reports = 9, []Report{{Card: "walk__1", Reason: "two_right", At: "x"}}
	if err := cache.Put(ctx, "en", walk); err != nil {
		t.Fatal(err)
	}
	again, _ := cache.Get(ctx, "en", "walk")
	if again.Version != 9 || len(again.Reports) != 1 || len(cache.Index(ctx, "en")) != len(content.Items.Keys) {
		t.Fatalf("new version: %+v", again)
	}
	if _, err := cache.Get(ctx, "en", "never_made"); err == nil {
		t.Fatal("an item never made is not there")
	}
}

func s3ForTest(t *testing.T) blobs.Store {
	t.Helper()
	parts := splitEnv(os.Getenv("ESTUDO_S3_TEST"))
	if len(parts) != 4 {
		t.Skip("ESTUDO_S3_TEST not set")
	}
	return &blobs.S3{Endpoint: parts[0], Bucket: parts[1], AccessKey: parts[2], SecretKey: parts[3], Region: "auto"}
}

func splitEnv(value string) []string {
	if value == "" {
		return nil
	}
	out, start := []string{}, 0
	for n := range value {
		if value[n] == '|' {
			out = append(out, value[start:n])
			start = n + 1
		}
	}
	return append(out, value[start:])
}
