package blobs

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

// AWS's own example of a signed GET (Amazon S3 API reference, "Signature Calculations for the Authorization Header", GET Object).
func TestSignatureMatchesTheAWSExample(t *testing.T) {
	request, _ := http.NewRequest(http.MethodGet, "https://examplebucket.s3.amazonaws.com/test.txt", nil)
	request.Header.Set("Range", "bytes=0-9")
	signV4(request, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "AKIAIOSFODNN7EXAMPLE", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "us-east-1", time.Date(2013, 5, 24, 0, 0, 0, 0, time.UTC))
	want := "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
	if got := request.Header.Get("Authorization"); got != want {
		t.Fatalf("Authorization =\n%s\nwant\n%s", got, want)
	}
}

// The S3 client talks the S3 protocol: path style, the multipart calls, the range and the metadata.
func TestS3TalksTheS3Protocol(t *testing.T) {
	var seen []string
	objects := map[string]string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.Header.Get("Authorization"), "AWS4-HMAC-SHA256 Credential=key/") {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		body, _ := io.ReadAll(r.Body)
		seen = append(seen, r.Method+" "+r.URL.RequestURI())
		switch {
		case r.Method == http.MethodPost && r.URL.Query().Has("uploads"):
			io.WriteString(w, `<InitiateMultipartUploadResult><UploadId>up-1</UploadId></InitiateMultipartUploadResult>`)
		case r.Method == http.MethodPut && r.URL.Query().Has("partNumber"):
			w.Header().Set("ETag", `"etag-`+r.URL.Query().Get("partNumber")+`"`)
		case r.Method == http.MethodPost && r.URL.Query().Has("uploadId"):
			if !strings.Contains(string(body), `<PartNumber>1</PartNumber><ETag>&#34;etag-1&#34;</ETag>`) {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			io.WriteString(w, `<CompleteMultipartUploadResult><Key>k</Key></CompleteMultipartUploadResult>`)
		case r.Method == http.MethodPut:
			objects[r.URL.Path] = string(body) + "|" + r.Header.Get("x-amz-meta-user")
		case r.Method == http.MethodGet:
			value, ok := objects[r.URL.Path]
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			if r.Header.Get("Range") == "bytes=1-2" {
				w.Header().Set("Content-Range", "bytes 1-2/"+strconv.Itoa(len(value)))
				w.WriteHeader(http.StatusPartialContent)
				io.WriteString(w, value[1:3])
				return
			}
			io.WriteString(w, value)
		}
	}))
	defer server.Close()
	store := &S3{Endpoint: server.URL, Bucket: "estudo", AccessKey: "key", SecretKey: "secret", Region: "auto"}
	ctx := context.Background()
	if err := store.Put(ctx, "u/1/i/n 1/text/v1.md", []byte("olá"), "text/markdown", map[string]string{"user": "1"}); err != nil {
		t.Fatal(err)
	}
	reader, info, err := store.Get(ctx, "u/1/i/n 1/text/v1.md", &Range{Start: 1, End: 2})
	if err != nil {
		t.Fatal(err)
	}
	part, _ := io.ReadAll(reader)
	reader.Close()
	if len(part) != 2 || info.Size != int64(len("olá|1")) {
		t.Fatalf("range = %q, size %d", part, info.Size)
	}
	if _, _, err := store.Get(ctx, "nada", nil); err != ErrNotFound {
		t.Fatalf("missing object: %v", err)
	}
	id, err := store.CreateMultipart(ctx, "u/1/i/n/media/m.webm", "video/webm", nil)
	if err != nil || id != "up-1" {
		t.Fatalf("upload id %q, %v", id, err)
	}
	etag, err := store.UploadPart(ctx, "u/1/i/n/media/m.webm", id, 1, []byte("parte"))
	if err != nil || etag != `"etag-1"` {
		t.Fatalf("etag %q, %v", etag, err)
	}
	if err := store.CompleteMultipart(ctx, "u/1/i/n/media/m.webm", id, []Part{{N: 1, ETag: etag}}); err != nil {
		t.Fatal(err)
	}
	if seen[0] != "PUT /estudo/u/1/i/n%201/text/v1.md" {
		t.Fatalf("path style with the key escaped: %q", seen[0])
	}
}

func TestMemoryKeepsMultipartWhole(t *testing.T) {
	store := NewMemory()
	ctx := context.Background()
	id, _ := store.CreateMultipart(ctx, "k", "audio/webm", nil)
	e2, _ := store.UploadPart(ctx, "k", id, 2, []byte("mundo"))
	e1, _ := store.UploadPart(ctx, "k", id, 1, []byte("olá "))
	if err := store.CompleteMultipart(ctx, "k", id, []Part{{N: 2, ETag: e2}, {N: 1, ETag: e1}}); err != nil {
		t.Fatal(err)
	}
	reader, info, _ := store.Get(ctx, "k", &Range{Start: 5, End: -1})
	body, _ := io.ReadAll(reader)
	if string(body) != "mundo" || info.Size != int64(len("olá mundo")) || store.OpenUploads() != 0 {
		t.Fatalf("got %q size %d open %d", body, info.Size, store.OpenUploads())
	}
}
