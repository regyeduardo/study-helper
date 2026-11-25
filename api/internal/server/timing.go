package server

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/regyeduardo/study-helper/api/internal/blobs"
)

// Server-Timing on every answer (spec 007, T019/T020, research R1): "total" is the time until the answer's headers went out, "blobs"
// the time spent on the storage (calls and reading what came back), "app" the rest (Go and SQLite). The measures of the app read it
// through the browser's Resource Timing (Timing-Allow-Origin) and split each operation between the network, the server and the device.
// The split inside "app" (SQLite against Go) is the job of the Go profiler, not of this header.

type timingKey struct{}

type requestClock struct {
	started time.Time
	blobs   atomic.Int64
}

func clockOf(ctx context.Context) *requestClock {
	clock, _ := ctx.Value(timingKey{}).(*requestClock)
	return clock
}

func (c *requestClock) add(since time.Time) {
	if c != nil {
		c.blobs.Add(int64(time.Since(since)))
	}
}

// timed is the whole API with the clock of each request.
func (srv *Server) timed(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		clock := &requestClock{started: time.Now()}
		writer := &timingWriter{ResponseWriter: w, clock: clock, origin: srv.cfg.AppOrigin}
		next.ServeHTTP(writer, r.WithContext(context.WithValue(r.Context(), timingKey{}, clock)))
	})
}

type timingWriter struct {
	http.ResponseWriter
	clock  *requestClock
	origin string
	sent   bool
}

func (w *timingWriter) stamp() {
	if w.sent {
		return
	}
	w.sent = true
	total := time.Since(w.clock.started)
	storage := time.Duration(w.clock.blobs.Load())
	h := w.Header()
	h.Set("Server-Timing", fmt.Sprintf("total;dur=%.1f, blobs;dur=%.1f, app;dur=%.1f", ms(total), ms(storage), ms(max(0, total-storage))))
	h.Set("Timing-Allow-Origin", w.origin)
}

func ms(d time.Duration) float64 { return float64(d) / float64(time.Millisecond) }

func (w *timingWriter) WriteHeader(status int) {
	w.stamp()
	w.ResponseWriter.WriteHeader(status)
}

func (w *timingWriter) Write(body []byte) (int, error) {
	w.stamp()
	return w.ResponseWriter.Write(body)
}

// Flush and Hijack keep working through the wrapper: the AI answers stream, the live channel is a WebSocket.
func (w *timingWriter) Flush() {
	w.stamp()
	if flusher, ok := w.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func (w *timingWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hijacker, ok := w.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, fmt.Errorf("http.ResponseWriter does not implement http.Hijacker")
	}
	return hijacker.Hijack()
}

func (w *timingWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// timedBlobs counts the time of each storage call, and of reading what it gives back, on the request's clock.
type timedBlobs struct{ inner blobs.Store }

func (t timedBlobs) Put(ctx context.Context, key string, body []byte, contentType string, meta map[string]string) error {
	defer clockOf(ctx).add(time.Now())
	return t.inner.Put(ctx, key, body, contentType, meta)
}

func (t timedBlobs) Get(ctx context.Context, key string, rng *blobs.Range) (io.ReadCloser, blobs.Info, error) {
	started := time.Now()
	reader, info, err := t.inner.Get(ctx, key, rng)
	clock := clockOf(ctx)
	clock.add(started)
	if err != nil || clock == nil {
		return reader, info, err
	}
	return &timedReader{ReadCloser: reader, clock: clock}, info, nil
}

func (t timedBlobs) Head(ctx context.Context, key string) (blobs.Info, error) {
	defer clockOf(ctx).add(time.Now())
	return t.inner.Head(ctx, key)
}

func (t timedBlobs) Delete(ctx context.Context, key string) error {
	defer clockOf(ctx).add(time.Now())
	return t.inner.Delete(ctx, key)
}

func (t timedBlobs) CreateMultipart(ctx context.Context, key, contentType string, meta map[string]string) (string, error) {
	defer clockOf(ctx).add(time.Now())
	return t.inner.CreateMultipart(ctx, key, contentType, meta)
}

func (t timedBlobs) UploadPart(ctx context.Context, key, uploadID string, n int, body []byte) (string, error) {
	defer clockOf(ctx).add(time.Now())
	return t.inner.UploadPart(ctx, key, uploadID, n, body)
}

func (t timedBlobs) CompleteMultipart(ctx context.Context, key, uploadID string, parts []blobs.Part) error {
	defer clockOf(ctx).add(time.Now())
	return t.inner.CompleteMultipart(ctx, key, uploadID, parts)
}

func (t timedBlobs) AbortMultipart(ctx context.Context, key, uploadID string) error {
	defer clockOf(ctx).add(time.Now())
	return t.inner.AbortMultipart(ctx, key, uploadID)
}

func (t timedBlobs) List(ctx context.Context, prefix string) ([]blobs.Object, error) {
	defer clockOf(ctx).add(time.Now())
	return t.inner.List(ctx, prefix)
}

type timedReader struct {
	io.ReadCloser
	clock *requestClock
}

func (r *timedReader) Read(p []byte) (int, error) {
	defer r.clock.add(time.Now())
	return r.ReadCloser.Read(p)
}
