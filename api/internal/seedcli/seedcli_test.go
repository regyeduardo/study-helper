package seedcli

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDefaultsAreTheFullTestLibrary(t *testing.T) {
	options, err := Parse(nil)
	if err != nil {
		t.Fatal(err)
	}
	if options.Email != "teste-perf@local" || options.Notes != 1000 || options.Transcripts != 100 || options.TranscriptMinutes != 60 || options.Media != 50 || options.Folders != 10 {
		t.Fatalf("%+v", options)
	}
	if options.Password == "" || options.Redo || options.Fill != 0 {
		t.Fatalf("%+v", options)
	}
}

func TestFlags(t *testing.T) {
	dir := t.TempDir()
	short := filepath.Join(dir, "curta.webm")
	long := filepath.Join(dir, "longa.webm")
	_ = os.WriteFile(short, []byte("curta"), 0o600)
	_ = os.WriteFile(long, []byte("longa"), 0o600)
	options, err := Parse([]string{"--email", "outra@local", "--notas", "20", "--transcricoes", "2", "--minutos", "5", "--midias", "1", "--pastas", "4",
		"--midia-curta", short, "--midia-longa", long, "--encher", "9.5GB", "--refazer"})
	if err != nil {
		t.Fatal(err)
	}
	if options.Email != "outra@local" || options.Notes != 20 || options.Transcripts != 2 || options.TranscriptMinutes != 5 || options.Media != 1 || options.Folders != 4 {
		t.Fatalf("%+v", options)
	}
	if string(options.MediaContent) != "curta" || options.MediaMime != "audio/webm" || string(options.LongMedia) != "longa" || options.LongMediaMime != "audio/webm" {
		t.Fatalf("media %+v", options)
	}
	if options.Fill != 9_500_000_000 || !options.Redo {
		t.Fatalf("%+v", options)
	}
}

func TestSizes(t *testing.T) {
	for text, want := range map[string]int64{"9.5GB": 9_500_000_000, "500MB": 500_000_000, "10gb": 10_000_000_000, "1234": 1234} {
		got, err := size(text)
		if err != nil || got != want {
			t.Fatalf("%s: %d %v", text, got, err)
		}
	}
	if _, err := size("muito"); err == nil {
		t.Fatal("accepted a size that is not one")
	}
}

func TestFromEnvSplitsLikeAShell(t *testing.T) {
	options, err := FromEnv("--notas 3 --email 'teste perf@local'")
	if err != nil {
		t.Fatal(err)
	}
	if options.Notes != 3 || options.Email != "teste perf@local" {
		t.Fatalf("%+v", options)
	}
}
