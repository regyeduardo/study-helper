// Command estudo-semear seeds the test library of the measures (spec 007, research R1) in a test account (e-mail ending in @local),
// on the service's database and storage. With BLOBS=memory the storage lives only inside the service's own process: then use
// ESTUDO_SEMEAR on the dev service instead (see cmd/estudo).
package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/regyeduardo/study-helper/api/internal/blobs"
	"github.com/regyeduardo/study-helper/api/internal/seedcli"
	"github.com/regyeduardo/study-helper/api/internal/server"
	"github.com/regyeduardo/study-helper/api/internal/store"
)

func env(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func main() {
	options, err := seedcli.Parse(os.Args[1:])
	if err != nil {
		log.Fatal(err)
	}
	if os.Getenv("BLOBS") == "memory" {
		log.Fatal("BLOBS=memory: o conteúdo some ao fim deste processo; semeie pelo serviço de dev com ESTUDO_SEMEAR")
	}
	endpoint, bucket := os.Getenv("R2_ENDPOINT"), os.Getenv("R2_BUCKET")
	if endpoint == "" || bucket == "" {
		log.Fatal("R2_ENDPOINT e R2_BUCKET são necessários para guardar o conteúdo semeado")
	}
	key, err := base64.StdEncoding.DecodeString(os.Getenv("TOKEN_KEY"))
	if err != nil || len(key) != 32 {
		log.Fatal("TOKEN_KEY must be 32 bytes in base64")
	}
	db, err := store.Open(env("ESTUDO_DB", "/data/estudo.db"))
	if err != nil {
		log.Fatalf("database: %v", err)
	}
	defer db.Close()
	storage := &blobs.S3{Endpoint: endpoint, Bucket: bucket, AccessKey: os.Getenv("R2_ACCESS_KEY_ID"), SecretKey: os.Getenv("R2_SECRET_ACCESS_KEY"), Region: "auto",
		Client: &http.Client{Timeout: 5 * time.Minute}}
	api := server.New(db, server.Config{AppOrigin: env("APP_ORIGIN", "https://study.ryns.me"), PublicURL: env("PUBLIC_URL", "https://api.study.ryns.me"),
		TokenKey: key, Blobs: storage, Version: "semear"})
	started := time.Now()
	report, err := api.Seed(context.Background(), options)
	if err != nil {
		log.Fatalf("semear: %v", err)
	}
	out, _ := json.Marshal(report)
	log.Printf("semeado em %s: %s", time.Since(started).Round(time.Second), out)
}
