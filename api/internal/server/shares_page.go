package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"net/http"
	"sort"
	"strings"
)

// The address that people copy and agents read (spec 007, história 4, FR-038, research R13; contracts/api-shares.md): the app lives on
// GitHub Pages and runs nothing on a server, so only an address of this service can answer an agent that does not run JavaScript.
// /s/<id> is a page made here, with all the content in text and, for people, the way to the app's page of the link; /s/<id>.md and
// Accept: text/markdown give the same in Markdown; /s/<id>.json, the content of /v1/shared/<id>.

func (srv *Server) sharedPage(w http.ResponseWriter, r *http.Request, _ *Session) {
	raw := r.PathValue("ref")
	format := "html"
	accept := r.Header.Get("Accept")
	switch {
	case strings.HasSuffix(raw, ".md"):
		raw, format = strings.TrimSuffix(raw, ".md"), "md"
	case strings.HasSuffix(raw, ".json"):
		raw, format = strings.TrimSuffix(raw, ".json"), "json"
	case strings.Contains(accept, "text/markdown"):
		format = "md"
	case strings.Contains(accept, "application/json") && !strings.Contains(accept, "text/html"):
		format = "json"
	}
	refuse := func(status int, code, title, text string) {
		if format == "html" {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(status)
			_ = noticePage.Execute(w, map[string]any{"Title": title, "Text": text})
			return
		}
		if format == "md" {
			w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(status)
			fmt.Fprintf(w, "# %s\n\n%s\n", title, text)
			return
		}
		fail(w, status, code, nil)
	}
	link, err := scanLink(srv.db.QueryRow(`SELECT `+linkColumns+` FROM shared_links WHERE id = ? AND live = 1`, raw))
	switch {
	case err != nil:
		refuse(http.StatusNotFound, "share_not_found", "Link não encontrado", "Confira o endereço com quem compartilhou.")
		return
	case link.Stopped:
		refuse(http.StatusGone, "share_stopped", "Este item deixou de ser compartilhado", "Peça um link novo a quem compartilhou.")
		return
	case srv.expired(link):
		refuse(http.StatusGone, "link_expired", "Este link venceu", "Peça um link novo a quem compartilhou.")
		return
	}
	body, err := srv.sharedBody(r.Context(), link)
	if err != nil {
		if errors.Is(err, errLinkGone) {
			refuse(http.StatusGone, "item_removed", "O item foi removido", "Quem compartilhou tirou este item da biblioteca.")
			return
		}
		refuse(http.StatusInternalServerError, "internal_error", "Não deu para abrir o link agora", "Tente de novo em alguns minutos.")
		return
	}
	if format == "json" {
		writeJSON(w, http.StatusOK, body)
		return
	}
	doc := srv.sharedDoc(link, body)
	if format == "md" {
		w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write([]byte(doc.markdown()))
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_ = sharedPageTemplate.Execute(w, doc)
}

// sharedDocument is the link as text: its notes in the order of the family, each with its media, transcript and texts.
type sharedDocument struct {
	Title       string
	Owner       string
	AppURL      string
	MarkdownURL string
	Notes       []pageNote
}

type pageNote struct {
	Name     string
	Type     string
	MediaURL string
	Media    string
	Turns    []sharedTurn
	Texts    []sharedText
	Cards    []sharedCard
}

type sharedTurn struct{ Who, At, Text string }
type sharedText struct{ Title, Body string }
type sharedCard struct{ Front, Back string }

var noteTypeNames = map[string]string{"meeting": "Ata", "class": "Aula", "explanation": "Explicação", "reading": "Leitura", "video": "Vídeo", "audio": "Áudio", "pdf": "PDF", "link": "Link", "text": "Texto", "topic": "Tema", "document": "Outro arquivo"}

func clockText(seconds float64) string {
	total := int(seconds)
	if total >= 3600 {
		return fmt.Sprintf("%02d:%02d:%02d", total/3600, total/60%60, total%60)
	}
	return fmt.Sprintf("%02d:%02d", total/60, total%60)
}

func (srv *Server) sharedDoc(link *sharedLink, body map[string]any) sharedDocument {
	doc := sharedDocument{
		Title:       fmt.Sprint(body["title"]),
		AppURL:      strings.TrimRight(srv.cfg.AppOrigin, "/") + "/shared/" + link.ID,
		MarkdownURL: strings.TrimRight(srv.cfg.PublicURL, "/") + "/s/" + link.ID + ".md",
	}
	if owner, ok := body["owner"].(map[string]any); ok {
		doc.Owner = fmt.Sprint(owner["name"])
	}
	files, _ := body["files"].([]sharedFileOut)
	// the root first, then its family in the order of the library
	sort.SliceStable(files, func(i, j int) bool {
		rootI, rootJ := files[i].ID == link.ItemID, files[j].ID == link.ItemID
		if rootI != rootJ {
			return rootI
		}
		return files[i].Position < files[j].Position
	})
	for _, file := range files {
		note := pageNote{Name: file.Name}
		if file.NoteType != nil {
			note.Type = noteTypeNames[*file.NoteType]
		}
		if file.Media != nil {
			note.MediaURL = strings.TrimRight(srv.cfg.PublicURL, "/") + "/v1/shared/" + link.ID + "/media/" + file.ID
			// the size as people here write it: "0,7 MB"
			note.Media = fmt.Sprintf("%s, %s MB", file.Media.Mime, strings.Replace(fmt.Sprintf("%.1f", float64(file.Media.Bytes)/1e6), ".", ",", 1))
		}
		if raw, ok := file.Parts["transcript"]; ok {
			note.Turns = turnsOf(raw)
		}
		if text := strings.TrimSpace(file.Parts["text"]); text != "" {
			note.Texts = append(note.Texts, sharedText{Title: "Texto", Body: text})
		}
		if raw, ok := file.Parts["documents"]; ok {
			var documents struct {
				Documents []struct {
					Markdown string `json:"markdown"`
				} `json:"documents"`
			}
			if json.Unmarshal([]byte(raw), &documents) == nil {
				for _, document := range documents.Documents {
					if strings.TrimSpace(document.Markdown) != "" {
						note.Texts = append(note.Texts, sharedText{Title: "Documento", Body: document.Markdown})
					}
				}
			}
		}
		for part, raw := range file.Parts {
			if !strings.HasPrefix(part, "artifacts/") {
				continue
			}
			var deck struct {
				Kind  string `json:"kind"`
				Cards []struct {
					Front string `json:"front"`
					Back  string `json:"back"`
				} `json:"cards"`
			}
			if json.Unmarshal([]byte(raw), &deck) == nil && deck.Kind == "cartoes" {
				for _, card := range deck.Cards {
					note.Cards = append(note.Cards, sharedCard{Front: card.Front, Back: card.Back})
				}
			}
		}
		doc.Notes = append(doc.Notes, note)
	}
	return doc
}

// turnsOf reads a transcript part: who spoke (the name given by hand, when there is one), when and what.
func turnsOf(raw string) []sharedTurn {
	var transcript struct {
		Recording *struct {
			Blocks []struct {
				Speaker string  `json:"speaker"`
				Start   float64 `json:"start"`
				Text    string  `json:"text"`
			} `json:"blocks"`
			Speakers []struct {
				ID   string `json:"id"`
				Name string `json:"name"`
			} `json:"speakers"`
		} `json:"recording"`
	}
	if json.Unmarshal([]byte(raw), &transcript) != nil || transcript.Recording == nil {
		return nil
	}
	names := map[string]string{}
	for _, speaker := range transcript.Recording.Speakers {
		names[speaker.ID] = speaker.Name
	}
	var turns []sharedTurn
	for _, block := range transcript.Recording.Blocks {
		who := block.Speaker
		if name, ok := names[who]; ok && name != "" {
			who = name
		}
		turns = append(turns, sharedTurn{Who: who, At: clockText(block.Start), Text: block.Text})
	}
	return turns
}

func (doc sharedDocument) markdown() string {
	var out strings.Builder
	fmt.Fprintf(&out, "# %s\n\n", doc.Title)
	if doc.Owner != "" {
		fmt.Fprintf(&out, "Compartilhado por %s no Estudo. Abrir no app: %s\n\n", doc.Owner, doc.AppURL)
	}
	for _, note := range doc.Notes {
		fmt.Fprintf(&out, "## %s", note.Name)
		if note.Type != "" {
			fmt.Fprintf(&out, " (%s)", note.Type)
		}
		out.WriteString("\n\n")
		if note.MediaURL != "" {
			fmt.Fprintf(&out, "Mídia (%s): %s\n\n", note.Media, note.MediaURL)
		}
		if len(note.Turns) > 0 {
			out.WriteString("### Transcrição\n\n")
			for _, turn := range note.Turns {
				fmt.Fprintf(&out, "**%s** [%s]: %s\n\n", turn.Who, turn.At, turn.Text)
			}
		}
		for _, text := range note.Texts {
			fmt.Fprintf(&out, "### %s\n\n%s\n\n", text.Title, strings.TrimSpace(text.Body))
		}
		if len(note.Cards) > 0 {
			out.WriteString("### Cartões\n\n")
			for _, card := range note.Cards {
				fmt.Fprintf(&out, "- %s → %s\n", card.Front, card.Back)
			}
			out.WriteString("\n")
		}
	}
	return out.String()
}

const pageStyle = `body{margin:0;font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1d2025;background:#fafaf9}
main{max-width:760px;margin:0 auto;padding:32px 20px 64px}
header{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;margin-bottom:24px}
h1{font-size:24px;line-height:1.25;margin:0}h2{font-size:19px;margin:32px 0 8px}h3{font-size:15px;margin:20px 0 6px;color:#4b5563}
.who{color:#6b7280;margin:4px 0 0}.open{display:inline-flex;align-items:center;min-height:44px;padding:0 16px;border-radius:8px;background:#1f6feb;color:#fff;text-decoration:none;font-weight:600}
.turn{margin:6px 0}.turn b{font-weight:600}.turn time{color:#6b7280;font-variant-numeric:tabular-nums;margin:0 6px}
pre{white-space:pre-wrap;font:inherit;margin:0}.media a{word-break:break-all}
@media (prefers-color-scheme:dark){body{background:#16181c;color:#e5e7eb}.who,.turn time,h3{color:#9ca3af}}`

var sharedPageTemplate = template.Must(template.New("page").Parse(`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{{.Title}} · Estudo</title>
<link rel="alternate" type="text/markdown" href="{{.MarkdownURL}}">
<style>` + pageStyle + `</style>
<script>location.replace({{.AppURL}})</script></head>
<body><main>
<header><div><h1>{{.Title}}</h1>{{if .Owner}}<p class="who">Compartilhado por {{.Owner}} no Estudo</p>{{end}}</div>
<a class="open" href="{{.AppURL}}">Abrir no app</a></header>
{{range .Notes}}<section>
<h2>{{.Name}}{{if .Type}} <small>({{.Type}})</small>{{end}}</h2>
{{if .MediaURL}}<p class="media">Mídia ({{.Media}}): <a href="{{.MediaURL}}">{{.MediaURL}}</a></p>{{end}}
{{if .Turns}}<h3>Transcrição</h3>{{range .Turns}}<p class="turn"><b>{{.Who}}</b><time>{{.At}}</time>{{.Text}}</p>{{end}}{{end}}
{{range .Texts}}<h3>{{.Title}}</h3><pre>{{.Body}}</pre>{{end}}
{{if .Cards}}<h3>Cartões</h3><ul>{{range .Cards}}<li>{{.Front}} → {{.Back}}</li>{{end}}</ul>{{end}}
</section>{{end}}
</main></body></html>`))

var noticePage = template.Must(template.New("notice").Parse(`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{{.Title}} · Estudo</title>
<style>` + pageStyle + `</style></head><body><main><h1>{{.Title}}</h1><p class="who">{{.Text}}</p></main></body></html>`))
