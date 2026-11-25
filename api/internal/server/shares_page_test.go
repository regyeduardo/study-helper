package server

import (
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

// The address that people copy and agents read (spec 007, FR-038, SC-008; contracts/api-shares.md): /s/<id> is a page made on the
// server, readable without running anything, with the transcript (who spoke and when), the notes and the address of the media; .md
// and Accept: text/markdown give the same in Markdown; .json the content of today. An expired link shows nothing.

func get(t *testing.T, h *harness, path, accept string) (*http.Response, string) {
	t.Helper()
	request, _ := http.NewRequest(http.MethodGet, h.api.URL+path, nil)
	if accept != "" {
		request.Header.Set("Accept", accept)
	}
	res, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	return res, string(raw)
}

func meetingLink(t *testing.T, h *harness) (string, *http.Client) {
	t.Helper()
	ana, _ := h.account("enabled", true, "ana@exemplo.com")
	storedMedia(t, h, ana)
	h.do(ana, call{method: http.MethodPut, path: "/v1/library/items/n1", body: map[string]any{"baseRev": 1, "row": row("Reunião de equipe", map[string]any{"noteType": "video"})}})
	putPart(t, h, ana, "n1", "transcript", `{"recording":{"blocks":[{"speaker":"s1","start":0,"end":5,"text":"bom dia a todos"},{"speaker":"s2","start":75,"end":80,"text":"vamos ao relatório"}],"speakers":[{"id":"s1","name":"Ana","suggested":false},{"id":"s2","name":"Bruno","suggested":false}],"marks":[]},"transcript":"Ana: bom dia a todos"}`)
	putRow(t, h, ana, "ata", row("Ata da reunião", map[string]any{"noteType": "meeting", "parentFileId": "n1"}))
	putPart(t, h, ana, "ata", "text", "# Ata\n\n- Entregar o relatório na sexta")
	made := share(t, h, ana, "")
	_ = made
	_, out := h.do(ana, call{method: http.MethodPost, path: "/v1/shares", body: map[string]any{"item": "n1", "kind": "entrada"}})
	return out["id"].(string), ana
}

func TestPageForAgents(t *testing.T) {
	h := newHarness(t)
	id, ana := meetingLink(t, h)
	// the page, without running anything
	res, page := get(t, h, "/s/"+id, "text/html")
	if res.StatusCode != 200 || !strings.HasPrefix(res.Header.Get("Content-Type"), "text/html") {
		t.Fatalf("page %d %s", res.StatusCode, res.Header.Get("Content-Type"))
	}
	for _, want := range []string{"Reunião de equipe", "Ana", "00:00", "bom dia a todos", "Bruno", "01:15", "vamos ao relatório", "Ata da reunião", "Entregar o relatório na sexta",
		"/v1/shared/" + id + "/media/n1", "Abrir no app", appOrigin + "/shared/" + id, "location.replace("} {
		if !strings.Contains(page, want) {
			t.Fatalf("the page has no %q:\n%s", want, page)
		}
	}
	// Markdown, by the address or by Accept
	for _, try := range []struct{ path, accept string }{{"/s/" + id + ".md", ""}, {"/s/" + id, "text/markdown"}} {
		res, md := get(t, h, try.path, try.accept)
		if res.StatusCode != 200 || !strings.HasPrefix(res.Header.Get("Content-Type"), "text/markdown") || !strings.Contains(md, "**Bruno** [01:15]: vamos ao relatório") || !strings.Contains(md, "# Reunião de equipe") {
			t.Fatalf("%s %s: %d %s\n%s", try.path, try.accept, res.StatusCode, res.Header.Get("Content-Type"), md)
		}
	}
	// the JSON of today
	if res, js := get(t, h, "/s/"+id+".json", ""); res.StatusCode != 200 || !strings.Contains(js, `"files"`) {
		t.Fatalf("json %d %s", res.StatusCode, js)
	}
	// a name changed by hand shows at the next read (FR-060)
	_, item := h.do(ana, call{path: "/v1/library/items/n1"})
	version := item["parts"].(map[string]any)["transcript"].(string)
	renamed := `{"recording":{"blocks":[{"speaker":"s2","start":75,"end":80,"text":"vamos ao relatório"}],"speakers":[{"id":"s2","name":"Bruno Souza","suggested":false}],"marks":[]},"transcript":""}`
	if res, out := h.raw(ana, http.MethodPut, "/v1/library/items/n1/parts/transcript", []byte(renamed), map[string]string{"If-Match": `"` + version + `"`}); res.StatusCode != 200 {
		t.Fatalf("rename: %d %s", res.StatusCode, out)
	}
	if _, md := get(t, h, "/s/"+id+".md", ""); !strings.Contains(md, "**Bruno Souza** [01:15]") {
		t.Fatalf("renamed speaker:\n%s", md)
	}
}

func TestExpiredPageShowsNothing(t *testing.T) {
	h := newHarness(t)
	id, ana := meetingLink(t, h)
	h.do(ana, call{method: http.MethodPatch, path: "/v1/shares/" + id, body: map[string]any{"expiresIn": "1d"}})
	h.now = h.now.Add(25 * time.Hour)
	for _, try := range []struct{ path, accept string }{{"/s/" + id, "text/html"}, {"/s/" + id + ".md", ""}, {"/s/" + id + ".json", ""}} {
		res, body := get(t, h, try.path, try.accept)
		if res.StatusCode != http.StatusGone || strings.Contains(body, "bom dia") || strings.Contains(body, "Reunião de equipe") {
			t.Fatalf("%s: %d\n%s", try.path, res.StatusCode, body)
		}
	}
	if _, page := get(t, h, "/s/"+id, "text/html"); !strings.Contains(page, "Este link venceu") {
		t.Fatalf("no notice:\n%s", page)
	}
	if res, _ := get(t, h, "/s/nao-existe", "text/html"); res.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown link %d", res.StatusCode)
	}
}
