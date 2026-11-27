// Command estudo-juntar-nomes (spec 005, T052, FR-022) undoes once the repeated names from before the rule: folders of the same name in
// the same folder become one (the emptied one goes to the Trash) and the newer of notes of the same name get " (2)". It copies the
// database first (VACUUM INTO, next to it); -simular only says what would change; -usuario limits it to one account (e-mail or id).
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"github.com/regyeduardo/study-helper/api/internal/server"
	"github.com/regyeduardo/study-helper/api/internal/store"
)

func main() {
	simulate := flag.Bool("simular", false, "só diz o que mudaria, sem mudar nada nem copiar o banco")
	only := flag.String("usuario", "", "só esta conta (e-mail ou id)")
	flag.Parse()
	path := strings.TrimSpace(os.Getenv("ESTUDO_DB"))
	if path == "" {
		path = "/data/estudo.db"
	}
	db, err := store.Open(path)
	if err != nil {
		log.Fatalf("banco: %v", err)
	}
	defer db.Close()
	if !*simulate {
		copyPath := fmt.Sprintf("%s.antes-juntar-nomes-%s", path, time.Now().UTC().Format("20060102-150405"))
		if _, err := db.Exec(`VACUUM INTO ?`, copyPath); err != nil {
			log.Fatalf("cópia do banco (nada foi mudado): %v", err)
		}
		log.Printf("cópia do banco: %s", copyPath)
	}
	reports, err := server.RepairAllNames(context.Background(), db, time.Now().UTC(), *only, !*simulate)
	for _, report := range reports {
		if report.FoldersJoined == 0 && report.NotesRenamed == 0 {
			continue
		}
		out, _ := json.Marshal(report)
		fmt.Println(string(out))
	}
	if err != nil {
		log.Fatalf("parou em: %v", err)
	}
	verb := "mudou"
	if *simulate {
		verb = "mudaria (simulado)"
	}
	folders, notes := 0, 0
	for _, report := range reports {
		folders += report.FoldersJoined
		notes += report.NotesRenamed
	}
	log.Printf("%d contas vistas; %s: %d pastas juntadas, %d notas com número", len(reports), verb, folders, notes)
}
