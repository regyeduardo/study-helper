package blobs

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

// S3 is Cloudflare R2 (or any S3) through its S3 API, path style (<endpoint>/<bucket>/<key>), signed with AWS Signature V4.
// Written by hand to keep the binary free of the AWS SDK; the signature is checked against AWS's own example in the tests.
type S3 struct {
	// Endpoint is https://<account>.r2.cloudflarestorage.com (R2_ENDPOINT).
	Endpoint  string
	Bucket    string
	AccessKey string
	SecretKey string
	// Region is "auto" for R2.
	Region string
	Client *http.Client
	Now    func() time.Time
}

func (s *S3) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s *S3) client() *http.Client {
	if s.Client != nil {
		return s.Client
	}
	return http.DefaultClient
}

// escape is the URI encoding of SigV4: everything but the unreserved characters, and "/" too unless it is a path separator.
func escape(text string, keepSlash bool) string {
	var b strings.Builder
	for i := 0; i < len(text); i++ {
		c := text[i]
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9', c == '-', c == '_', c == '.', c == '~':
			b.WriteByte(c)
		case c == '/' && keepSlash:
			b.WriteByte(c)
		default:
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

func canonicalQuery(query url.Values) string {
	keys := make([]string, 0, len(query))
	for key := range query {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		values := append([]string(nil), query[key]...)
		sort.Strings(values)
		for _, value := range values {
			parts = append(parts, escape(key, false)+"="+escape(value, false))
		}
	}
	return strings.Join(parts, "&")
}

func hmacSHA256(key []byte, text string) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(text))
	return mac.Sum(nil)
}

func sha256Hex(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

// signV4 signs the request (host, range, content type, content md5 and every x-amz-* header) and sets Authorization.
func signV4(r *http.Request, payloadHash, accessKey, secretKey, region string, now time.Time) {
	stamp := now.UTC().Format("20060102T150405Z")
	day := stamp[:8]
	r.Header.Set("x-amz-date", stamp)
	r.Header.Set("x-amz-content-sha256", payloadHash)
	headers := map[string]string{"host": r.URL.Host}
	for name, values := range r.Header {
		lower := strings.ToLower(name)
		if strings.HasPrefix(lower, "x-amz-") || lower == "range" || lower == "content-type" || lower == "content-md5" {
			headers[lower] = strings.TrimSpace(strings.Join(values, ","))
		}
	}
	names := make([]string, 0, len(headers))
	for name := range headers {
		names = append(names, name)
	}
	sort.Strings(names)
	var canonicalHeaders strings.Builder
	for _, name := range names {
		canonicalHeaders.WriteString(name + ":" + headers[name] + "\n")
	}
	signedHeaders := strings.Join(names, ";")
	path := r.URL.EscapedPath()
	if raw := r.URL.RawPath; raw == "" {
		path = escape(r.URL.Path, true)
	}
	if path == "" {
		path = "/"
	}
	canonical := strings.Join([]string{r.Method, path, canonicalQuery(r.URL.Query()), canonicalHeaders.String(), signedHeaders, payloadHash}, "\n")
	scope := day + "/" + region + "/s3/aws4_request"
	toSign := strings.Join([]string{"AWS4-HMAC-SHA256", stamp, scope, sha256Hex([]byte(canonical))}, "\n")
	key := hmacSHA256([]byte("AWS4"+secretKey), day)
	key = hmacSHA256(key, region)
	key = hmacSHA256(key, "s3")
	key = hmacSHA256(key, "aws4_request")
	signature := hex.EncodeToString(hmacSHA256(key, toSign))
	r.Header.Set("Authorization", fmt.Sprintf("AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s", accessKey, scope, signedHeaders, signature))
}

func (s *S3) do(ctx context.Context, method, key string, query url.Values, body []byte, headers map[string]string) (*http.Response, error) {
	target := strings.TrimRight(s.Endpoint, "/") + "/" + escape(s.Bucket, false) + "/" + escape(key, true)
	if len(query) > 0 {
		target += "?" + canonicalQuery(query)
	}
	request, err := http.NewRequestWithContext(ctx, method, target, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.ContentLength = int64(len(body))
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	signV4(request, sha256Hex(body), s.AccessKey, s.SecretKey, s.Region, s.now())
	response, err := s.client().Do(request)
	if err != nil {
		return nil, err
	}
	if response.StatusCode == http.StatusNotFound {
		response.Body.Close()
		return nil, ErrNotFound
	}
	if response.StatusCode >= 300 {
		detail, _ := io.ReadAll(io.LimitReader(response.Body, 512))
		response.Body.Close()
		return nil, fmt.Errorf("storage %s %s: %d %s", method, key, response.StatusCode, strings.TrimSpace(string(detail)))
	}
	return response, nil
}

func metaHeaders(contentType string, meta map[string]string) map[string]string {
	headers := map[string]string{}
	if contentType != "" {
		headers["Content-Type"] = contentType
	}
	for name, value := range meta {
		headers["x-amz-meta-"+strings.ToLower(name)] = value
	}
	return headers
}

func infoOf(response *http.Response) Info {
	info := Info{ContentType: response.Header.Get("Content-Type"), ETag: response.Header.Get("ETag"), Size: response.ContentLength}
	if total := response.Header.Get("Content-Range"); total != "" {
		if slash := strings.LastIndex(total, "/"); slash >= 0 {
			if size, err := strconv.ParseInt(total[slash+1:], 10, 64); err == nil {
				info.Size = size
			}
		}
	}
	if modified, err := http.ParseTime(response.Header.Get("Last-Modified")); err == nil {
		info.LastModified = modified
	}
	return info
}

func (s *S3) Put(ctx context.Context, key string, body []byte, contentType string, meta map[string]string) error {
	response, err := s.do(ctx, http.MethodPut, key, nil, body, metaHeaders(contentType, meta))
	if err != nil {
		return err
	}
	response.Body.Close()
	return nil
}

func (s *S3) Get(ctx context.Context, key string, rng *Range) (io.ReadCloser, Info, error) {
	headers := map[string]string{}
	if rng != nil {
		if rng.End >= 0 {
			headers["Range"] = fmt.Sprintf("bytes=%d-%d", rng.Start, rng.End)
		} else {
			headers["Range"] = fmt.Sprintf("bytes=%d-", rng.Start)
		}
	}
	response, err := s.do(ctx, http.MethodGet, key, nil, nil, headers)
	if err != nil {
		return nil, Info{}, err
	}
	return response.Body, infoOf(response), nil
}

func (s *S3) Head(ctx context.Context, key string) (Info, error) {
	response, err := s.do(ctx, http.MethodHead, key, nil, nil, nil)
	if err != nil {
		return Info{}, err
	}
	response.Body.Close()
	return infoOf(response), nil
}

func (s *S3) Delete(ctx context.Context, key string) error {
	response, err := s.do(ctx, http.MethodDelete, key, nil, nil, nil)
	if err == ErrNotFound {
		return nil
	}
	if err != nil {
		return err
	}
	response.Body.Close()
	return nil
}

func (s *S3) CreateMultipart(ctx context.Context, key, contentType string, meta map[string]string) (string, error) {
	response, err := s.do(ctx, http.MethodPost, key, url.Values{"uploads": {""}}, nil, metaHeaders(contentType, meta))
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	var answer struct {
		UploadID string `xml:"UploadId"`
	}
	if err := xml.NewDecoder(response.Body).Decode(&answer); err != nil || answer.UploadID == "" {
		return "", fmt.Errorf("storage: no upload id: %v", err)
	}
	return answer.UploadID, nil
}

func (s *S3) UploadPart(ctx context.Context, key, uploadID string, n int, body []byte) (string, error) {
	response, err := s.do(ctx, http.MethodPut, key, url.Values{"partNumber": {strconv.Itoa(n)}, "uploadId": {uploadID}}, body, nil)
	if err != nil {
		return "", err
	}
	response.Body.Close()
	return response.Header.Get("ETag"), nil
}

func (s *S3) CompleteMultipart(ctx context.Context, key, uploadID string, parts []Part) error {
	sort.Slice(parts, func(i, j int) bool { return parts[i].N < parts[j].N })
	var body bytes.Buffer
	body.WriteString("<CompleteMultipartUpload>")
	for _, part := range parts {
		fmt.Fprintf(&body, "<Part><PartNumber>%d</PartNumber><ETag>%s</ETag></Part>", part.N, xmlEscape(part.ETag))
	}
	body.WriteString("</CompleteMultipartUpload>")
	response, err := s.do(ctx, http.MethodPost, key, url.Values{"uploadId": {uploadID}}, body.Bytes(), map[string]string{"Content-Type": "application/xml"})
	if err != nil {
		return err
	}
	defer response.Body.Close()
	// S3 may answer 200 with an error in the body
	answer, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
	if bytes.Contains(answer, []byte("<Error>")) {
		return fmt.Errorf("storage complete %s: %s", key, strings.TrimSpace(string(answer)))
	}
	return nil
}

func (s *S3) AbortMultipart(ctx context.Context, key, uploadID string) error {
	response, err := s.do(ctx, http.MethodDelete, key, url.Values{"uploadId": {uploadID}}, nil, nil)
	if err == ErrNotFound {
		return nil
	}
	if err != nil {
		return err
	}
	response.Body.Close()
	return nil
}

func xmlEscape(text string) string {
	var b bytes.Buffer
	_ = xml.EscapeText(&b, []byte(text))
	return b.String()
}
