// Command medir-transcricao runs the server's transcription (T204) on a media file on disk, to measure its time, cost and memory (T208,
// SC-012 to SC-014): medir-transcricao <mídia> <pasta de trabalho>. The keys come from DEEPINFRA_API_KEY and OPENROUTER_API_KEY.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/regyeduardo/study-helper/api/internal/transcribe"
)

func peakMB() int {
	status, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(status), "\n") {
		if strings.HasPrefix(line, "VmHWM:") {
			var kb int
			fmt.Sscanf(strings.TrimSpace(strings.TrimPrefix(line, "VmHWM:")), "%d", &kb)
			return kb / 1024
		}
	}
	return 0
}

func main() {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "uso: medir-transcricao <mídia> <pasta de trabalho>")
		os.Exit(2)
	}
	media, workdir := os.Args[1], os.Args[2]
	cfg := transcribe.Config{
		Keys:     map[string]string{"deepinfra": os.Getenv("DEEPINFRA_API_KEY"), "openrouter": os.Getenv("OPENROUTER_API_KEY")},
		Language: "pt",
		Progress: func(stage string, done, total int) { fmt.Fprintf(os.Stderr, "%s %d/%d\n", stage, done, total) },
	}
	started := time.Now()
	result, err := transcribe.Run(context.Background(), cfg, media, nil, workdir)
	if err != nil {
		fmt.Fprintln(os.Stderr, "falhou:", err)
		os.Exit(1)
	}
	_ = os.WriteFile(filepath.Join(workdir, "texto.txt"), []byte(result.Text), 0o600)
	words := len(strings.Fields(result.Text))
	summary, _ := json.Marshal(map[string]any{"segundos": time.Since(started).Seconds(), "custo_usd": result.Cost, "duracao": result.Duration, "blocos": len(result.Blocks), "vozes": len(result.Speakers), "palavras": words, "aviso": result.Warning, "etapas": result.Stages, "rss_go_mb": peakMB()})
	fmt.Println(string(summary))
}
