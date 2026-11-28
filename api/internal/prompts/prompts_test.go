package prompts

import (
	"strings"
	"testing"
)

// T204: the instructions the backend in Go uses are there, as text.
func TestTheInstructionsOfTheTranscriptionAreThere(t *testing.T) {
	for _, name := range []string{"POLISH_PROMPT", "TITLE_PROMPT", "SCREEN_ASKS_PROMPT", "SCREEN_TEXT_PROMPT", "SCREEN_NAME_PROMPT", "MEETING_PROMPT"} {
		if strings.TrimSpace(Text(name)) == "" {
			t.Fatalf("%s is empty", name)
		}
	}
}
