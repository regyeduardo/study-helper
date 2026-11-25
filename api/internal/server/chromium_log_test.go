package server

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// "Ainda não transcreve" (dono, 24/11): the job's Chromium wrote nowhere, so a job that failed or never ended in production left no
// trace. What it writes (its errors and the console of the app's page) goes to the service's log, with the job's id.

type logLines struct {
	mu    sync.Mutex
	lines []string
}

func (l *logLines) logf(format string, args ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lines = append(l.lines, fmt.Sprintf(format, args...))
}

func (l *logLines) of(prefix string) []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	var found []string
	for _, line := range l.lines {
		if strings.HasPrefix(line, prefix) {
			found = append(found, line)
		}
	}
	return found
}

func chromiumScript(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "chromium")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestTheJobsChromiumWritesToTheLog(t *testing.T) {
	h := newHarness(t)
	logs := &logLines{}
	h.srv.cfg.Logf = logs.logf
	h.srv.cfg.ChromiumPath = chromiumScript(t, `echo "args: $*" >&2
echo 'saída comum'
echo '[1:2:INFO:CONSOLE(12)] "A IA do app está indisponível para o trabalho", source: https://study.ryns.me/assets/index.js (12)' >&2
printf 'sem fim de linha' >&2
`)
	if err := h.srv.runChromium(context.Background(), JobStart{ID: "job-x", EnterURL: "http://exemplo.test/v1/jobs/job-x/entrar?ticket=t"}); err != nil {
		t.Fatal(err)
	}
	lines := strings.Join(logs.of("jobs: job-x chromium: "), "\n")
	// the console of the page comes out only with Chromium's logging on stderr
	for _, want := range []string{"--enable-logging=stderr", "saída comum", `"A IA do app está indisponível para o trabalho"`, "sem fim de linha"} {
		if !strings.Contains(lines, want) {
			t.Fatalf("o log não tem %q:\n%s", want, lines)
		}
	}
	// the ticket that lets the page in is not written to the log
	if strings.Contains(lines, "ticket=t") {
		t.Fatalf("o ticket foi para o log:\n%s", lines)
	}
}

func TestTheJobsChromiumLogHasACeiling(t *testing.T) {
	h := newHarness(t)
	logs := &logLines{}
	h.srv.cfg.Logf = logs.logf
	h.srv.cfg.ChromiumPath = chromiumScript(t, `i=0; while [ $i -lt 1000 ]; do echo "linha $i $(printf '%02000d' 0)" >&2; i=$((i+1)); done`)
	if err := h.srv.runChromium(context.Background(), JobStart{ID: "job-y", EnterURL: "http://exemplo.test/"}); err != nil {
		t.Fatal(err)
	}
	lines := logs.of("jobs: job-y chromium: ")
	if len(lines) != chromiumLogLines+1 {
		t.Fatalf("%d linhas no log, queria %d e o aviso do corte", len(lines), chromiumLogLines)
	}
	if !strings.Contains(lines[len(lines)-1], "cortado") {
		t.Fatalf("sem o aviso do corte: %q", lines[len(lines)-1])
	}
	for _, line := range lines {
		if len(line) > chromiumLineMax+64 {
			t.Fatalf("linha longa demais no log: %d", len(line))
		}
	}
}
