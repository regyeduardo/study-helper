package main

import (
	"testing"

	"github.com/regyeduardo/study-helper/api/internal/blobs"
)

func setBlobEnv(t *testing.T, mode, endpoint, bucket string) {
	t.Helper()
	t.Setenv("BLOBS", mode)
	t.Setenv("R2_ENDPOINT", endpoint)
	t.Setenv("R2_BUCKET", bucket)
}

func TestBlobStoreOffWithoutR2(t *testing.T) {
	setBlobEnv(t, "", "", "")
	if store := blobStore(); store != nil {
		t.Fatalf("without R2 nor BLOBS the App stays off, got %T", store)
	}
}

func TestBlobStoreR2WhenConfigured(t *testing.T) {
	setBlobEnv(t, "", "https://account.r2.cloudflarestorage.com", "bucket")
	store, ok := blobStore().(*blobs.S3)
	if !ok || store.Bucket != "bucket" || store.Endpoint != "https://account.r2.cloudflarestorage.com" {
		t.Fatalf("R2 configured must give the S3 store, got %#v", store)
	}
}

// BLOBS=memory (dev and end-to-end tests) never reaches R2, even when its variables are set.
func TestBlobStoreMemoryWinsOverR2(t *testing.T) {
	setBlobEnv(t, "memory", "https://account.r2.cloudflarestorage.com", "bucket")
	if _, ok := blobStore().(*blobs.Memory); !ok {
		t.Fatal("BLOBS=memory must keep the media in memory")
	}
}
