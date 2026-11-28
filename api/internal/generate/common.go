package generate

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"strings"

	"github.com/regyeduardo/study-helper/api/internal/transcribe"
)

// chunkOverlap is how much of the end of a piece the next one repeats (src/lib/generation/minutes.ts, CHUNK_OVERLAP).
const chunkOverlap = 800

// InstructionHead marks the "Instrução extra para a IA" at the end of what the model reads (src/lib/generation/instruction.ts).
const InstructionHead = "## Instrução de quem pediu (siga com prioridade, sem inventar nada)"

// Chunks are the pieces of a long text, as the browser cuts them (transcriptChunks), counted in letters as JavaScript counts them.
func Chunks(text string) []string {
	runes := []rune(text)
	if len(runes) <= chunkChars {
		return []string{text}
	}
	pieces := []string{}
	for start := 0; start < len(runes); {
		end := min(start+chunkChars, len(runes))
		pieces = append(pieces, string(runes[start:end]))
		if end == len(runes) {
			break
		}
		start = end - chunkOverlap
	}
	return pieces
}

// WithInstruction is the request with the instruction of whoever asked below it; an empty one leaves it as it was.
func WithInstruction(content, instruction string) string {
	said := strings.TrimSpace(instruction)
	if said == "" {
		return content
	}
	return content + "\n\n" + InstructionHead + "\n\n" + said
}

// NewID is an id as the app makes them (src/lib/ids.ts, newId: a UUID v4).
func NewID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

func cancelled(ctx context.Context, err error) bool {
	return errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) || ctx.Err() != nil
}

const namePrompt = `Você dá nome a um material de estudo feito a partir de uma nota, em português do Brasil: um mapa mental, um baralho de cartões de memorização ou uma conversa com o tutor. Você recebe o tipo e o conteúdo do material e, às vezes, a instrução de quem pediu. Responda só com JSON no formato {"nome": "..."}. O nome diz do que trata ESTE material, com 2 a 6 palavras, sem aspas e sem ponto final, sem repetir o tipo (nada de "Mapa mental de…" ou "Cartões sobre…"). Se houver instrução, o nome mostra o foco dela. Use os nomes de conceitos, matérias, projetos e pessoas que aparecem no conteúdo. Se o conteúdo não tiver assunto claro, devolva {"nome": ""}.`

var kindLabels = map[string]string{"mapa": "mapa mental", "cartoes": "cartões de memorização", "tutor": "conversa com o tutor"}

// NameArtifact is a short, specific name for an artifact from its own content (src/lib/generation/artifact-name.ts); "" when the AI
// fails or has none.
func NameArtifact(ctx context.Context, chat Chat, content, kind, instruction string) (string, error) {
	opening := Chunks(strings.TrimSpace(content))[0]
	if opening == "" {
		return "", nil
	}
	answer, err := chat(ctx, WithInstruction("Tipo: "+kindLabels[kind]+"\n\nConteúdo:\n"+opening, instruction), namePrompt, 200)
	if err != nil {
		if cancelled(ctx, err) {
			return "", err
		}
		return "", nil
	}
	return transcribe.CleanTitle(ExtractJSON(answer)["nome"]), nil
}
