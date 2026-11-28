package generate

import (
	"context"
	"encoding/json"
	"regexp"
	"strings"

	"github.com/regyeduardo/study-helper/api/internal/prompts"
	"github.com/regyeduardo/study-helper/api/internal/transcribe"
)

// MapLink is an extra arrow to another node ("fluxo").
type MapLink struct {
	To    string `json:"to"`
	Label string `json:"label,omitempty"`
}

// MapNode is a node of a mind map (src/types/domain.ts).
type MapNode struct {
	ID       string     `json:"id"`
	Text     string     `json:"text"`
	Mark     string     `json:"mark,omitempty"`
	Group    bool       `json:"group,omitempty"`
	Links    []MapLink  `json:"links,omitempty"`
	Children []*MapNode `json:"children"`
}

// MapDiagram is a map: its form and its tree.
type MapDiagram struct {
	Form string   `json:"form"`
	Root *MapNode `json:"root"`
}

var (
	mapForms   = []string{"radial", "arvore", "fluxo", "linha-do-tempo"}
	runsOf     = regexp.MustCompile(`\s+`)
	notLetters = regexp.MustCompile(`[^\p{L}\p{N}]+`)
)

func saidOf(value any) string {
	text, _ := value.(string)
	return strings.TrimSpace(runsOf.ReplaceAllString(text, " "))
}

func itemsOf(value any) []map[string]any {
	list, _ := value.([]any)
	out := []map[string]any{}
	for _, item := range list {
		if row, ok := item.(map[string]any); ok {
			out = append(out, row)
		}
	}
	return out
}

func formOf(value any) string {
	for _, form := range mapForms {
		if value == form {
			return form
		}
	}
	return ""
}

func allNodes(node *MapNode) []*MapNode {
	out := []*MapNode{node}
	for _, child := range node.Children {
		out = append(out, allNodes(child)...)
	}
	return out
}

// nodesOf: the AI's nodes with ids made here; `refs` keeps the id the AI wrote, which its links point to. A node without text gives
// way to its children.
func nodesOf(raw map[string]any, refs map[string]string) []*MapNode {
	children := []*MapNode{}
	for _, child := range itemsOf(raw["filhos"]) {
		children = append(children, nodesOf(child, refs)...)
	}
	text := saidOf(raw["texto"])
	if text == "" {
		return children
	}
	node := &MapNode{ID: NewID(), Text: text, Children: children, Mark: saidOf(raw["marca"]), Group: raw["grupo"] == true}
	for _, link := range itemsOf(raw["ligacoes"]) {
		if to := saidOf(link["para"]); to != "" {
			node.Links = append(node.Links, MapLink{To: to, Label: saidOf(link["rotulo"])})
		}
	}
	if ref := saidOf(raw["id"]); ref != "" {
		if _, ok := refs[ref]; !ok {
			refs[ref] = node.ID
		}
	}
	return []*MapNode{node}
}

type mapPart struct {
	name, form string
	root       *MapNode
}

func partOf(answer map[string]any) *mapPart {
	raw, ok := answer["raiz"].(map[string]any)
	name := saidOf(answer["nome"])
	if !ok {
		return nil
	}
	text := saidOf(raw["texto"])
	if text == "" {
		text = name
	}
	if text == "" {
		return nil
	}
	copied := map[string]any{}
	for key, value := range raw {
		copied[key] = value
	}
	copied["texto"] = text
	refs := map[string]string{}
	root := nodesOf(copied, refs)[0]
	if len(root.Children) == 0 {
		return nil
	}
	for _, node := range allNodes(root) {
		kept := []MapLink{}
		for _, link := range node.Links {
			if id, ok := refs[link.To]; ok {
				kept = append(kept, MapLink{To: id, Label: link.Label})
			}
		}
		node.Links = kept
		if len(kept) == 0 {
			node.Links = nil
		}
	}
	if name == "" {
		name = text
	}
	form := formOf(answer["forma"])
	if form == "" {
		form = "radial"
	}
	return &mapPart{name: name, form: form, root: root}
}

// fold puts `extra` into `kept`, which keeps its id: the two said the same thing.
func fold(kept, extra *MapNode, moved map[string]string) *MapNode {
	moved[extra.ID] = kept.ID
	node := *kept
	node.Children = append(append([]*MapNode{}, kept.Children...), extra.Children...)
	if node.Mark == "" && extra.Mark != "" {
		node.Mark = extra.Mark
	}
	if extra.Group {
		node.Group = true
	}
	if len(extra.Links) > 0 {
		node.Links = append(append([]MapLink{}, kept.Links...), extra.Links...)
	}
	return &node
}

func sameness(text string) string {
	plain := strings.TrimSpace(notLetters.ReplaceAllString(transcribe.WithoutAccents(text), " "))
	if plain == "" {
		return text
	}
	return plain
}

// combined: nodes with the same text become one, all the way down (the overlap between the parts repeats some).
func combined(nodes []*MapNode, moved map[string]string) []*MapNode {
	order := []string{}
	kept := map[string]*MapNode{}
	for _, node := range nodes {
		key := sameness(node.Text)
		if earlier, ok := kept[key]; ok {
			kept[key] = fold(earlier, node, moved)
		} else {
			order = append(order, key)
			kept[key] = node
		}
	}
	out := make([]*MapNode, 0, len(order))
	for _, key := range order {
		node := *kept[key]
		node.Children = combined(node.Children, moved)
		out = append(out, &node)
	}
	return out
}

// branches keeps the branches of the parts in their order, each one usable once.
type branches struct {
	order []string
	by    map[string]*MapNode
}

func (b *branches) take(id string) *MapNode {
	node, ok := b.by[id]
	if !ok {
		return nil
	}
	delete(b.by, id)
	return node
}

func (b *branches) left() []*MapNode {
	out := []*MapNode{}
	for _, id := range b.order {
		if node, ok := b.by[id]; ok {
			out = append(out, node)
		}
	}
	return out
}

// joined is one branch of the merge answer: the branches it names, joined. A branch kept alone keeps its own words.
func joined(asked map[string]any, left *branches, moved map[string]string) []*MapNode {
	ids, _ := asked["junta"].([]any)
	taken := []*MapNode{}
	for _, id := range ids {
		if branch := left.take(saidOf(id)); branch != nil {
			taken = append(taken, branch)
		}
	}
	if len(taken) == 0 {
		return nil
	}
	if len(taken) == 1 {
		return taken
	}
	head := *taken[0]
	if text := saidOf(asked["texto"]); text != "" {
		head.Text = text
	}
	node := &head
	for _, other := range taken[1:] {
		node = fold(node, other, moved)
	}
	return []*MapNode{node}
}

type outlineBranch struct {
	ID       string   `json:"id"`
	Text     string   `json:"texto"`
	Children []string `json:"filhos"`
}

type outlinePart struct {
	Name     string          `json:"nome"`
	Form     string          `json:"forma"`
	Root     string          `json:"raiz"`
	Branches []outlineBranch `json:"ramos"`
}

// merged: the AI orders and joins the parts' branches by id, so it cannot drop or rewrite one; whatever it leaves out goes at the end.
func merged(ctx context.Context, chat Chat, parts []*mapPart, instruction string, moved map[string]string) (*mapPart, error) {
	outline := struct {
		Parts []outlinePart `json:"partes"`
	}{}
	left := &branches{by: map[string]*MapNode{}}
	for _, part := range parts {
		item := outlinePart{Name: part.name, Form: part.form, Root: part.root.Text, Branches: []outlineBranch{}}
		for _, branch := range part.root.Children {
			children := []string{}
			for _, child := range branch.Children {
				children = append(children, child.Text)
			}
			item.Branches = append(item.Branches, outlineBranch{ID: branch.ID, Text: branch.Text, Children: children})
			left.order = append(left.order, branch.ID)
			left.by[branch.ID] = branch
		}
		outline.Parts = append(outline.Parts, item)
	}
	raw, _ := marshalPlain(outline)
	reply, err := chat(ctx, WithInstruction(raw, instruction), prompts.Text("MINDMAP_MERGE_PROMPT"), 0)
	if err != nil {
		return nil, err
	}
	answer := ExtractJSON(reply)
	ordered := []*MapNode{}
	for _, asked := range itemsOf(answer["ramos"]) {
		ordered = append(ordered, joined(asked, left, moved)...)
	}
	first := parts[0]
	for _, part := range parts[1:] {
		moved[part.root.ID] = first.root.ID
	}
	root := *first.root
	if text := saidOf(answer["raiz"]); text != "" {
		root.Text = text
	}
	root.Children = combined(append(ordered, left.left()...), moved)
	name := saidOf(answer["nome"])
	if name == "" {
		name = first.name
	}
	form := formOf(answer["forma"])
	if form == "" {
		form = first.form
	}
	return &mapPart{name: name, form: form, root: &root}, nil
}

// marshalPlain is JSON as JSON.stringify writes it (no escaping of <, > and &).
func marshalPlain(value any) (string, error) {
	var out strings.Builder
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return "", err
	}
	return strings.TrimSuffix(out.String(), "\n"), nil
}

// linked: links follow the nodes folded into others; links to nodes that are gone, to themselves or repeated go away.
func linked(root *MapNode, moved map[string]string) *MapNode {
	ids := map[string]bool{}
	for _, node := range allNodes(root) {
		ids[node.ID] = true
	}
	target := func(id string) string {
		at := id
		for hop := 0; hop <= len(moved); hop++ {
			next, ok := moved[at]
			if !ok {
				break
			}
			at = next
		}
		return at
	}
	var tidy func(node *MapNode) *MapNode
	tidy = func(node *MapNode) *MapNode {
		out := *node
		out.Links = nil
		for _, link := range node.Links {
			link.To = target(link.To)
			repeated := false
			for _, other := range out.Links {
				if other.To == link.To && other.Label == link.Label {
					repeated = true
				}
			}
			if ids[link.To] && link.To != node.ID && !repeated {
				out.Links = append(out.Links, link)
			}
		}
		out.Children = make([]*MapNode, len(node.Children))
		for i, child := range node.Children {
			out.Children[i] = tidy(child)
		}
		return &out
	}
	return tidy(root)
}

// Map is the map of the WHOLE note (src/lib/generation/mindmap.ts): a long one read in parts, one map per part, the parts merged. The
// AI picks the form and a free tree; the ids are made here. Nil: the AI gave no map.
func Map(ctx context.Context, chat Chat, content, instruction string) (string, *MapDiagram, error) {
	text := strings.TrimSpace(content)
	if text == "" {
		return "", nil, nil
	}
	parts := []*mapPart{}
	for _, piece := range Chunks(text) {
		reply, err := chat(ctx, WithInstruction(piece, instruction), prompts.Text("MINDMAP_PROMPT"), 0)
		if err != nil {
			return "", nil, err
		}
		if part := partOf(ExtractJSON(reply)); part != nil {
			parts = append(parts, part)
		}
	}
	if len(parts) == 0 {
		return "", nil, nil
	}
	moved := map[string]string{}
	whole := parts[0]
	if len(parts) > 1 {
		var err error
		if whole, err = merged(ctx, chat, parts, instruction, moved); err != nil {
			return "", nil, err
		}
	}
	return whole.name, &MapDiagram{Form: whole.form, Root: linked(whole.root, moved)}, nil
}
