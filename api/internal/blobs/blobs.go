// Package blobs is where the content of the library lives (spec 003, entrega 4): Cloudflare R2 through its S3 API in production,
// memory in the tests. An object written never changes; each save of a part is a new object.
package blobs

import (
	"context"
	"errors"
	"io"
	"time"
)

// ErrNotFound is an object (or multipart upload) that is not there.
var ErrNotFound = errors.New("blob not found")

// Info describes a stored object.
type Info struct {
	Size         int64
	ContentType  string
	ETag         string
	LastModified time.Time
}

// Range is a byte range, both ends included; End < 0 means "to the end".
type Range struct {
	Start, End int64
}

// Part is a received part of a multipart upload.
type Part struct {
	N    int
	ETag string
}

// Store is the storage the server needs.
type Store interface {
	Put(ctx context.Context, key string, body []byte, contentType string, meta map[string]string) error
	// Get gives the object, or the asked range of it; the caller closes the reader.
	Get(ctx context.Context, key string, rng *Range) (io.ReadCloser, Info, error)
	Head(ctx context.Context, key string) (Info, error)
	Delete(ctx context.Context, key string) error
	CreateMultipart(ctx context.Context, key, contentType string, meta map[string]string) (string, error)
	UploadPart(ctx context.Context, key, uploadID string, n int, body []byte) (string, error)
	CompleteMultipart(ctx context.Context, key, uploadID string, parts []Part) error
	AbortMultipart(ctx context.Context, key, uploadID string) error
}
