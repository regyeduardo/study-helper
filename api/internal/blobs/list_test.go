package blobs

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// spec 007, história 5 (T119): the daily check of the space lists what an account really keeps (u/<conta>/), with the size of each
// object; in R2, through ListObjectsV2, page by page.

func TestMemoryLists(t *testing.T) {
	store := NewMemory()
	ctx := context.Background()
	_ = store.Put(ctx, "u/ana/a", []byte("12345"), "text/plain", nil)
	_ = store.Put(ctx, "u/ana/b/c", []byte("12"), "text/plain", nil)
	_ = store.Put(ctx, "u/bruno/x", []byte("1"), "text/plain", nil)
	found, err := store.List(ctx, "u/ana/")
	if err != nil {
		t.Fatal(err)
	}
	if len(found) != 2 || found[0].Key != "u/ana/a" || found[0].Size != 5 || found[1].Key != "u/ana/b/c" || found[1].Size != 2 {
		t.Fatalf("%+v", found)
	}
}

func TestS3ListsPageByPage(t *testing.T) {
	var asked []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()
		if r.Method != http.MethodGet || query.Get("list-type") != "2" || query.Get("prefix") != "u/ana/" || !strings.HasPrefix(r.URL.Path, "/estudo") {
			http.Error(w, "unexpected "+r.Method+" "+r.URL.String(), http.StatusBadRequest)
			return
		}
		asked = append(asked, query.Get("continuation-token"))
		w.Header().Set("Content-Type", "application/xml")
		if query.Get("continuation-token") == "" {
			fmt.Fprint(w, `<?xml version="1.0"?><ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>page-2</NextContinuationToken>
				<Contents><Key>u/ana/a</Key><Size>5</Size></Contents><Contents><Key>u/ana/b</Key><Size>7</Size></Contents></ListBucketResult>`)
			return
		}
		fmt.Fprint(w, `<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>u/ana/c</Key><Size>11</Size></Contents></ListBucketResult>`)
	}))
	defer server.Close()
	store := &S3{Endpoint: server.URL, Bucket: "estudo", AccessKey: "k", SecretKey: "s", Region: "auto"}
	found, err := store.List(context.Background(), "u/ana/")
	if err != nil {
		t.Fatal(err)
	}
	var total int64
	for _, object := range found {
		total += object.Size
	}
	if len(found) != 3 || total != 23 || strings.Join(asked, ",") != ",page-2" {
		t.Fatalf("%+v asked %v", found, asked)
	}
}
