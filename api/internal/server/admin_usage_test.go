package server

import (
	"io"
	"net/http"
	"testing"
)

// FR-055 (spec 007, 003 FR-048): the owner sees, for each account, the jobs of generating (running, waiting, done and failed in the
// last 30 days) and the use of the app's AI (calls and tokens in the last 30 days, read from the provider's own count in its answer),
// to follow the cost. No limit of AI per account for now.

func adminAccount(t *testing.T, h *harness, admin *http.Client, email string) map[string]any {
	t.Helper()
	_, body := h.do(admin, call{path: "/v1/admin/accounts"})
	for _, item := range body["accounts"].([]any) {
		if account := item.(map[string]any); account["email"] == email {
			return account
		}
	}
	t.Fatalf("no account %s in %v", email, body)
	return nil
}

func TestAdminSeesJobsAndAIUseOfEachAccount(t *testing.T) {
	h, _ := jobsHarness(t, 2)
	admin, _ := h.admin()
	ana, _ := h.account("enabled", true, "ana@exemplo.com")
	provider, _ := fakeProvider(t, func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"Oi\"}}]}\n\n")
		_, _ = io.WriteString(w, "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":1200,\"completion_tokens\":340}}\n\ndata: [DONE]\n\n")
	})
	withAI(h, map[string]string{"deepinfra": "chave"}, map[string]string{"deepinfra": provider.URL})
	for range 2 {
		if res, out := h.raw(ana, http.MethodPost, "/v1/ai/deepinfra/v1/openai/chat/completions", []byte(`{"model":"m","stream":true}`), map[string]string{"Content-Type": "application/json"}); res.StatusCode != 200 {
			t.Fatalf("ai %d %s", res.StatusCode, out)
		}
	}
	_, job := newJob(t, h, ana, "generateFromNote", "n1")
	waitState(t, h, ana, job["id"].(string), "done")

	account := adminAccount(t, h, admin, "ana@exemplo.com")
	jobs, _ := account["jobs"].(map[string]any)
	if jobs == nil || jobs["done"] != float64(1) || jobs["running"] != float64(0) || jobs["queued"] != float64(0) || jobs["failed"] != float64(0) {
		t.Fatalf("jobs %v", account["jobs"])
	}
	ai, _ := account["ai"].(map[string]any)
	if ai == nil || ai["calls"] != float64(2) || ai["inputTokens"] != float64(2400) || ai["outputTokens"] != float64(680) {
		t.Fatalf("ai %v", account["ai"])
	}
	// another account's use is its own
	if other := adminAccount(t, h, admin, "dono@exemplo.com"); other["ai"].(map[string]any)["calls"] != float64(0) {
		t.Fatalf("owner ai %v", other["ai"])
	}
}

func TestAITokensOfEachProviderAndCutBetweenPieces(t *testing.T) {
	for name, answer := range map[string]string{
		"openai":    `data: {"choices":[{"delta":{"content":"\"prompt_tokens\": 9"}}]}` + "\n\n" + `data: {"usage":{"prompt_tokens":100,"completion_tokens":20}}`,
		"anthropic": `event: message_start` + "\n" + `data: {"message":{"usage":{"input_tokens":100,"output_tokens":1}}}` + "\n\n" + `data: {"type":"message_delta","usage":{"output_tokens":20}}`,
		"gemini":    `data: {"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":5}}` + "\n\n" + `data: {"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":20}}`,
	} {
		for _, size := range []int{1, 7, 4096} {
			tokens := &aiTokens{}
			for at := 0; at < len(answer); at += size {
				tokens.read([]byte(answer[at:min(len(answer), at+size)]))
			}
			if tokens.input != 100 || tokens.output != 20 {
				t.Errorf("%s in pieces of %d: %d in, %d out", name, size, tokens.input, tokens.output)
			}
		}
	}
}
