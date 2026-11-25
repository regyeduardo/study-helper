// Package seedcli reads the options of the test-library seeder (spec 007, research R1) from command-line flags, for the
// estudo-semear command and for ESTUDO_SEMEAR on a dev server whose storage lives in memory.
package seedcli

import (
	"flag"
	"fmt"
	"io"
	"mime"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/regyeduardo/study-helper/api/internal/server"
)

// DefaultPassword signs in to the test account in the measures; it is a test account's, never a real one.
const DefaultPassword = "teste-perf-123"

// Parse reads the flags; with none, it is the full test library of the spec (1,000 notes, 100 transcripts of 1 hour, 50 media).
func Parse(args []string) (server.SeedOptions, error) {
	set := flag.NewFlagSet("estudo-semear", flag.ContinueOnError)
	set.SetOutput(io.Discard)
	options := server.SeedOptions{}
	set.StringVar(&options.Email, "email", "teste-perf@local", "e-mail da conta de teste (precisa terminar em @local)")
	set.StringVar(&options.Password, "senha", DefaultPassword, "senha da conta de teste")
	set.IntVar(&options.Folders, "pastas", 10, "pastas (a 1ª tem as notas, a 2ª as reuniões, a 3ª as mídias, o resto uma dentro da outra)")
	set.IntVar(&options.Notes, "notas", 1000, "notas de texto na pasta grande")
	set.IntVar(&options.Transcripts, "transcricoes", 100, "reuniões com transcrição")
	set.IntVar(&options.TranscriptMinutes, "minutos", 60, "minutos de cada transcrição")
	set.IntVar(&options.Media, "midias", 50, "mídias curtas no App")
	shortPath := set.String("midia-curta", "", "arquivo tocável para as mídias curtas")
	longPath := set.String("midia-longa", "", "arquivo tocável de cerca de 1 hora, na primeira reunião")
	fill := set.String("encher", "", "encher o espaço da conta com mídia falsa até este tamanho (ex.: 9.5GB)")
	set.BoolVar(&options.Redo, "refazer", false, "apagar a conta de teste e semear de novo")
	if err := set.Parse(args); err != nil {
		return options, err
	}
	var err error
	if options.MediaContent, options.MediaMime, err = file(*shortPath); err != nil {
		return options, err
	}
	if options.LongMedia, options.LongMediaMime, err = file(*longPath); err != nil {
		return options, err
	}
	if *fill != "" {
		if options.Fill, err = size(*fill); err != nil {
			return options, err
		}
	}
	return options, nil
}

// FromEnv reads the flags from one line (ESTUDO_SEMEAR), split as a shell would, with single or double quotes.
func FromEnv(line string) (server.SeedOptions, error) {
	var args []string
	var current strings.Builder
	var quote rune
	inWord := false
	for _, char := range line {
		switch {
		case quote != 0 && char == quote:
			quote = 0
		case quote == 0 && (char == '\'' || char == '"'):
			quote, inWord = char, true
		case quote == 0 && (char == ' ' || char == '\t'):
			if inWord {
				args = append(args, current.String())
				current.Reset()
				inWord = false
			}
		default:
			current.WriteRune(char)
			inWord = true
		}
	}
	if inWord {
		args = append(args, current.String())
	}
	return Parse(args)
}

func file(path string) ([]byte, string, error) {
	if path == "" {
		return nil, "", nil
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return nil, "", fmt.Errorf("mídia %s: %w", path, err)
	}
	// a .webm of the app's recordings is audio; anything else goes by its extension
	ext := strings.ToLower(filepath.Ext(path))
	kind := mime.TypeByExtension(ext)
	if ext == ".webm" || kind == "" {
		kind = "audio/webm"
	}
	return content, kind, nil
}

// size reads 9.5GB, 500MB or plain bytes (decimal units, as the space screens show).
func size(text string) (int64, error) {
	clean := strings.ToUpper(strings.TrimSpace(text))
	units := []struct {
		suffix string
		factor float64
	}{{"GB", 1e9}, {"MB", 1e6}, {"KB", 1e3}, {"B", 1}}
	for _, unit := range units {
		if strings.HasSuffix(clean, unit.suffix) {
			number, err := strconv.ParseFloat(strings.TrimSuffix(clean, unit.suffix), 64)
			if err != nil || number <= 0 {
				return 0, fmt.Errorf("tamanho inválido: %s", text)
			}
			return int64(number * unit.factor), nil
		}
	}
	number, err := strconv.ParseInt(clean, 10, 64)
	if err != nil || number <= 0 {
		return 0, fmt.Errorf("tamanho inválido: %s", text)
	}
	return number, nil
}
