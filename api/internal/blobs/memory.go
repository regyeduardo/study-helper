package blobs

import (
	"bytes"
	"context"
	"crypto/md5"
	"encoding/hex"
	"fmt"
	"io"
	"sort"
	"sync"
	"time"
)

// Memory is a Store in memory, for the tests; it keeps what the real one keeps and refuses what the real one refuses.
type Memory struct {
	mu      sync.Mutex
	objects map[string]memoryObject
	uploads map[string]*memoryUpload
	next    int
}

type memoryObject struct {
	body        []byte
	contentType string
	meta        map[string]string
	at          time.Time
}

type memoryUpload struct {
	key         string
	contentType string
	meta        map[string]string
	parts       map[int][]byte
}

func NewMemory() *Memory {
	return &Memory{objects: map[string]memoryObject{}, uploads: map[string]*memoryUpload{}}
}

func etagOf(body []byte) string {
	sum := md5.Sum(body)
	return `"` + hex.EncodeToString(sum[:]) + `"`
}

func (m *Memory) Put(_ context.Context, key string, body []byte, contentType string, meta map[string]string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.objects[key] = memoryObject{body: append([]byte(nil), body...), contentType: contentType, meta: meta, at: time.Now()}
	return nil
}

func (m *Memory) Get(_ context.Context, key string, rng *Range) (io.ReadCloser, Info, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	object, ok := m.objects[key]
	if !ok {
		return nil, Info{}, ErrNotFound
	}
	info := Info{Size: int64(len(object.body)), ContentType: object.contentType, ETag: etagOf(object.body), LastModified: object.at}
	body := object.body
	if rng != nil {
		end := rng.End
		if end < 0 || end >= info.Size {
			end = info.Size - 1
		}
		body = body[rng.Start : end+1]
	}
	return io.NopCloser(bytes.NewReader(body)), info, nil
}

func (m *Memory) Head(ctx context.Context, key string) (Info, error) {
	reader, info, err := m.Get(ctx, key, nil)
	if err == nil {
		reader.Close()
	}
	return info, err
}

func (m *Memory) Delete(_ context.Context, key string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.objects, key)
	return nil
}

func (m *Memory) CreateMultipart(_ context.Context, key, contentType string, meta map[string]string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.next++
	id := fmt.Sprintf("mpu-%d", m.next)
	m.uploads[id] = &memoryUpload{key: key, contentType: contentType, meta: meta, parts: map[int][]byte{}}
	return id, nil
}

func (m *Memory) UploadPart(_ context.Context, key, uploadID string, n int, body []byte) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	upload, ok := m.uploads[uploadID]
	if !ok || upload.key != key {
		return "", ErrNotFound
	}
	upload.parts[n] = append([]byte(nil), body...)
	return etagOf(body), nil
}

func (m *Memory) CompleteMultipart(_ context.Context, key, uploadID string, parts []Part) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	upload, ok := m.uploads[uploadID]
	if !ok || upload.key != key {
		return ErrNotFound
	}
	sort.Slice(parts, func(i, j int) bool { return parts[i].N < parts[j].N })
	var whole []byte
	for _, part := range parts {
		body, ok := upload.parts[part.N]
		if !ok || etagOf(body) != part.ETag {
			return fmt.Errorf("part %d missing or changed", part.N)
		}
		whole = append(whole, body...)
	}
	m.objects[key] = memoryObject{body: whole, contentType: upload.contentType, meta: upload.meta, at: time.Now()}
	delete(m.uploads, uploadID)
	return nil
}

func (m *Memory) AbortMultipart(_ context.Context, _ string, uploadID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.uploads, uploadID)
	return nil
}

// Keys lists what is stored, for the tests.
func (m *Memory) Keys() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	keys := make([]string, 0, len(m.objects))
	for key := range m.objects {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// OpenUploads counts the multipart uploads not completed nor aborted, for the tests.
func (m *Memory) OpenUploads() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.uploads)
}
