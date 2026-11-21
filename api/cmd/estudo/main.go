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
	api := server.New(db, server.Config{
		AppOrigin:     env("APP_ORIGIN", "https://study.ryns.me"),
		PublicURL:     env("PUBLIC_URL", "https://api.study.ryns.me"),
		AdminEmails:   admins,
		TokenKey:      key,
		Google:        server.DefaultGoogle(os.Getenv("GOOGLE_CLIENT_ID"), os.Getenv("GOOGLE_CLIENT_SECRET")),
		SecureCookies: env("SECURE_COOKIES", "true") != "false",
		Version:       version,
	})
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
