// Command estudo is the backend of the Estudo app (spec 003): one binary, one SQLite file.
package main

import (
	"context"
	"encoding/base64"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/regyeduardo/study-helper/api/internal/blobs"
	"github.com/regyeduardo/study-helper/api/internal/server"
	"github.com/regyeduardo/study-helper/api/internal/store"
)

// version is set at build time (-ldflags "-X main.version=<git sha>").
var version = "dev"

func env(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func main() {
	key, err := base64.StdEncoding.DecodeString(os.Getenv("TOKEN_KEY"))
	if err != nil || len(key) != 32 {
		log.Fatal("TOKEN_KEY must be 32 bytes in base64 (openssl rand -base64 32)")
	}
	db, err := store.Open(env("ESTUDO_DB", "/data/estudo.db"))
	if err != nil {
		log.Fatalf("database: %v", err)
	}
	defer db.Close()
	var admins []string
	for _, email := range strings.Split(os.Getenv("ADMIN_EMAILS"), ",") {
		if email = strings.TrimSpace(email); email != "" {
			admins = append(admins, email)
		}
	}
	storage := blobStore()
	api := server.New(db, server.Config{
		AppOrigin:     env("APP_ORIGIN", "https://study.ryns.me"),
		PublicURL:     env("PUBLIC_URL", "https://api.study.ryns.me"),
		AdminEmails:   admins,
		TokenKey:      key,
		Google:        googleConfig(),
		SecureCookies: env("SECURE_COOKIES", "true") != "false",
		Version:       version,
		Blobs:         storage,
		AI:            aiConfig(),
	})
	// once a day: recount the space and clean the storage (orphans after 31 days, uploads forgotten for 7, tombstones after 60)
	if storage != nil {
		go func() {
			time.Sleep(time.Minute)
			for {
				ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
				if err := api.CheckUsage(ctx); err != nil {
					log.Printf("usage check: %v", err)
				}
				if err := api.Clean(ctx); err != nil {
					log.Printf("cleaning: %v", err)
				}
				cancel()
				time.Sleep(24 * time.Hour)
			}
		}()
	}
	httpServer := &http.Server{Addr: env("ESTUDO_ADDR", ":8080"), Handler: api.Handler(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		log.Printf("estudo %s listening on %s", version, httpServer.Addr)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	_ = httpServer.Shutdown(ctx)
}

// blobStore is where the library's content lives (entrega 4): Cloudflare R2 through its S3 API; without it the App routes answer 503.
// BLOBS=memory keeps it in memory instead (dev and end-to-end tests only: lost when the server stops, never reaches R2).
func blobStore() blobs.Store {
	if os.Getenv("BLOBS") == "memory" {
		log.Print("BLOBS=memory: the library's content stays in memory and is lost when the server stops")
		return blobs.NewMemory()
	}
	if endpoint, bucket := os.Getenv("R2_ENDPOINT"), os.Getenv("R2_BUCKET"); endpoint != "" && bucket != "" {
		return &blobs.S3{Endpoint: endpoint, Bucket: bucket, AccessKey: os.Getenv("R2_ACCESS_KEY_ID"), SecretKey: os.Getenv("R2_SECRET_ACCESS_KEY"), Region: "auto",
			Client: &http.Client{Timeout: 5 * time.Minute}}
	}
	log.Print("R2_ENDPOINT/R2_BUCKET not set: the library in the App is off")
	return nil
}

// googleConfig is Google's sign-in, also accepting tokens of the app's own Google client (GOOGLE_TOKEN_AUDIENCES, comma separated):
// whoever is signed in with Google in the app turns on the structure without a second sign-in.
func googleConfig() server.GoogleConfig {
	google := server.DefaultGoogle(os.Getenv("GOOGLE_CLIENT_ID"), os.Getenv("GOOGLE_CLIENT_SECRET"))
	for _, client := range strings.Split(os.Getenv("GOOGLE_TOKEN_AUDIENCES"), ",") {
		if client = strings.TrimSpace(client); client != "" {
			google.TokenAudiences = append(google.TokenAudiences, client)
		}
	}
	return google
}

// aiConfig reads the app's AI keys (spec 006) only from the env: <PROVIDER>_API_KEY (DEEPINFRA_API_KEY, OPENROUTER_API_KEY, ...);
// a provider without one is off.
func aiConfig() server.AIConfig {
	keys := map[string]string{}
	for _, id := range server.AIProviders() {
		if key := strings.TrimSpace(os.Getenv(strings.ToUpper(id) + "_API_KEY")); key != "" {
			keys[id] = key
		}
	}
	return server.AIConfig{Keys: keys}
}
