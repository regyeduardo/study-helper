package generate

import (
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
)

// The diagrams of the app (src/lib/generation/mermaid.ts): the AI gives the data, the Mermaid code is written here.

var (
	flowchartShapes = map[string][2]string{"rounded": {"(", ")"}, "stadium": {"([", "])"}, "diam": {"{", "}"}, "circle": {"((", "))"}, "cyl": {"[(", ")]"}, "hex": {"{{", "}}"}, "parallelogram": {"[/", "/]"}}
	linkStyles      = map[string]string{"dotted": "-.->", "thick": "==>", "invisible": "~~~"}
	sequenceArrows  = map[string]string{"solid": "->>", "dashed": "-->>", "dotted": "-x", "async": "-)"}
	classRelations  = map[string]string{"inheritance": "--|>", "composition": "--*", "aggregation": "--o", "association": "-->"}
)

// DiagramError is data the diagram cannot be drawn from.
type DiagramError struct{ reason string }

func (e *DiagramError) Error() string { return e.reason }

func diagramError(reason string) error { return &DiagramError{reason} }

// jsText is a value as JavaScript's String() writes it.
func jsText(value any) string {
	switch v := value.(type) {
	case nil:
		return ""
	case string:
		return v
	case bool:
		return strconv.FormatBool(v)
	case float64:
		if v == math.Trunc(v) && math.Abs(v) < 1e21 {
			return strconv.FormatFloat(v, 'f', -1, 64)
		}
		return strconv.FormatFloat(v, 'g', -1, 64)
	case []any:
		parts := make([]string, len(v))
		for i, item := range v {
			parts[i] = jsText(item)
		}
		return strings.Join(parts, ",")
	default:
		return "[object Object]"
	}
}

// truthy is JavaScript's truth of a JSON value.
func truthy(value any) bool {
	switch v := value.(type) {
	case nil:
		return false
	case string:
		return v != ""
	case bool:
		return v
	case float64:
		return v != 0 && !math.IsNaN(v)
	default:
		return true
	}
}

func or(value, fallback any) any {
	if truthy(value) {
		return value
	}
	return fallback
}

func dataList(value any) []map[string]any {
	list, _ := value.([]any)
	out := make([]map[string]any, 0, len(list))
	for _, item := range list {
		row, _ := item.(map[string]any)
		out = append(out, row)
	}
	return out
}

func cleanLabel(value any) string {
	return strings.TrimSpace(strings.NewReplacer("(", " ", ")", " ", `"`, "'").Replace(jsText(value)))
}

func oneOf(value string, allowed []string, fallback string) string {
	for _, item := range allowed {
		if value == item {
			return value
		}
	}
	return fallback
}

func flowchartNode(node map[string]any) (string, error) {
	id := strings.TrimSpace(jsText(node["id"]))
	if id == "" {
		return "", diagramError("nó de flowchart sem id")
	}
	shape, ok := flowchartShapes[strings.ToLower(jsText(node["shape"]))]
	if !ok {
		shape = [2]string{"[", "]"}
	}
	return id + shape[0] + `"` + cleanLabel(or(node["text"], id)) + `"` + shape[1], nil
}

func flowchartLink(link map[string]any, prefix string) (string, error) {
	source := prefix + strings.TrimSpace(jsText(link["from"]))
	target := prefix + strings.TrimSpace(jsText(link["to"]))
	if strings.TrimSpace(source) == "" || strings.TrimSpace(target) == "" {
		return "", diagramError("ligação de flowchart sem origem ou destino")
	}
	arrow := "-->"
	if strings.ToLower(jsText(link["head"])) == "none" {
		arrow = "---"
	} else if style, ok := linkStyles[strings.ToLower(jsText(link["shape"]))]; ok {
		arrow = style
	}
	if truthy(link["text"]) && arrow != "~~~" {
		return source + " " + arrow + "|" + cleanLabel(link["text"]) + "| " + target, nil
	}
	return source + " " + arrow + " " + target, nil
}

func flowchartSubgraph(subgraph map[string]any, parentPrefix string) ([]string, error) {
	id := strings.TrimSpace(jsText(subgraph["id"]))
	if id == "" {
		return nil, diagramError("subgraph sem id")
	}
	prefix := parentPrefix + id + "_"
	lines := []string{"subgraph " + id + "[" + cleanLabel(or(subgraph["title"], id)) + "]"}
	for _, node := range dataList(subgraph["nodes"]) {
		if node == nil {
			return nil, diagramError("nó de subgraph precisa ser um objeto")
		}
		copied := map[string]any{}
		for key, value := range node {
			copied[key] = value
		}
		copied["id"] = prefix + jsText(node["id"])
		line, err := flowchartNode(copied)
		if err != nil {
			return nil, err
		}
		lines = append(lines, line)
	}
	for _, link := range dataList(subgraph["links"]) {
		line, err := flowchartLink(link, prefix)
		if err != nil {
			return nil, err
		}
		lines = append(lines, line)
	}
	for _, child := range dataList(subgraph["children"]) {
		more, err := flowchartSubgraph(child, prefix)
		if err != nil {
			return nil, err
		}
		lines = append(lines, more...)
	}
	return append(lines, "end"), nil
}

func flowchart(data map[string]any) (string, error) {
	nodes := dataList(data["nodes"])
	if len(nodes) == 0 {
		return "", diagramError("flowchart sem nós")
	}
	direction := oneOf(strings.ToUpper(jsText(or(data["direction"], "TD"))), []string{"TD", "TB", "LR", "RL", "BT"}, "TD")
	lines := []string{"flowchart " + direction}
	for _, node := range nodes {
		line, err := flowchartNode(node)
		if err != nil {
			return "", err
		}
		lines = append(lines, line)
	}
	for _, link := range dataList(data["links"]) {
		line, err := flowchartLink(link, "")
		if err != nil {
			return "", err
		}
		lines = append(lines, line)
	}
	for _, subgraph := range dataList(data["subgraphs"]) {
		more, err := flowchartSubgraph(subgraph, "")
		if err != nil {
			return "", err
		}
		lines = append(lines, more...)
	}
	return strings.Join(lines, "\n"), nil
}

func sequence(data map[string]any) (string, error) {
	actors := dataList(data["actors"])
	if len(actors) == 0 {
		return "", diagramError("sequence sem atores")
	}
	lines := []string{"sequenceDiagram"}
	if truthy(data["autonumber"]) {
		lines = append(lines, "    autonumber")
	}
	for _, actor := range actors {
		id := strings.TrimSpace(jsText(actor["id"]))
		if id == "" {
			return "", diagramError("ator de sequence sem id")
		}
		keyword := "participant"
		if strings.ToLower(jsText(actor["type"])) == "actor" {
			keyword = "actor"
		}
		if name := actor["name"]; truthy(name) && name != id {
			lines = append(lines, "    "+keyword+" "+id+" as "+cleanLabel(name))
		} else {
			lines = append(lines, "    "+keyword+" "+id)
		}
	}
	for _, message := range dataList(data["messages"]) {
		source, target := strings.TrimSpace(jsText(message["from"])), strings.TrimSpace(jsText(message["to"]))
		if source == "" || target == "" {
			return "", diagramError("mensagem de sequence sem origem ou destino")
		}
		arrow, ok := sequenceArrows[strings.ToLower(jsText(message["type"]))]
		if !ok {
			arrow = "->>"
		}
		lines = append(lines, "    "+source+arrow+target+": "+cleanLabel(message["text"]))
	}
	return strings.Join(lines, "\n"), nil
}

func classDiagram(data map[string]any) (string, error) {
	classes := dataList(data["classes"])
	if len(classes) == 0 {
		return "", diagramError("class diagram sem classes")
	}
	direction := oneOf(strings.ToUpper(jsText(or(data["direction"], "TB"))), []string{"TB", "LR", "RL", "BT"}, "TB")
	lines := []string{"classDiagram", "direction " + direction}
	for _, item := range classes {
		name := strings.TrimSpace(jsText(item["name"]))
		if name == "" {
			return "", diagramError("classe sem nome")
		}
		body := []string{}
		for _, member := range dataList(item["members"]) {
			visibility := jsText(or(jsText(member["visibility"]), "+"))
			body = append(body, strings.TrimRight("    "+visibility+jsText(member["type"])+" "+jsText(member["name"]), " \t\n"))
		}
		for _, method := range dataList(item["methods"]) {
			visibility := jsText(or(jsText(method["visibility"]), "+"))
			params := []string{}
			for _, param := range dataList(method["parameters"]) {
				params = append(params, strings.TrimSpace(jsText(param["type"])+" "+jsText(param["name"])))
			}
			returns := jsText(method["return_type"])
			if returns != "" {
				returns = " " + returns
			}
			body = append(body, "    "+visibility+jsText(method["name"])+"("+strings.Join(params, ", ")+")"+returns)
		}
		if len(body) > 0 {
			lines = append(append(append(lines, "class "+name+" {"), body...), "}")
		} else {
			lines = append(lines, "class "+name)
		}
	}
	for _, relation := range dataList(data["relations"]) {
		source, target := strings.TrimSpace(jsText(relation["from"])), strings.TrimSpace(jsText(relation["to"]))
		if source == "" || target == "" {
			return "", diagramError("relação de classe sem origem ou destino")
		}
		arrow, ok := classRelations[strings.ToLower(jsText(relation["type"]))]
		if !ok {
			arrow = "-->"
		}
		if truthy(relation["label"]) {
			lines = append(lines, source+" "+arrow+" "+target+" : "+cleanLabel(relation["label"]))
		} else {
			lines = append(lines, source+" "+arrow+" "+target)
		}
	}
	return strings.Join(lines, "\n"), nil
}

func stateDiagram(data map[string]any) (string, error) {
	states := dataList(data["states"])
	if len(states) == 0 {
		return "", diagramError("state diagram sem estados")
	}
	lines := []string{"stateDiagram-v2"}
	known := map[string]bool{}
	for _, state := range states {
		id := strings.TrimSpace(jsText(state["id"]))
		if id == "" {
			return "", diagramError("estado sem id")
		}
		known[id] = true
		if truthy(state["description"]) {
			lines = append(lines, "    "+id+" : "+cleanLabel(state["description"]))
		} else {
			lines = append(lines, "    "+id)
		}
	}
	for _, transition := range dataList(data["transitions"]) {
		source, target := strings.TrimSpace(jsText(transition["from"])), strings.TrimSpace(jsText(transition["to"]))
		if !known[source] || !known[target] {
			continue
		}
		if truthy(transition["description"]) {
			lines = append(lines, "    "+source+" --> "+target+" : "+cleanLabel(transition["description"]))
		} else {
			lines = append(lines, "    "+source+" --> "+target)
		}
	}
	return strings.Join(lines, "\n"), nil
}

func pie(data map[string]any) (string, error) {
	entries := dataList(data["data"])
	if len(entries) == 0 {
		return "", diagramError("pie sem dados")
	}
	lines := []string{"pie"}
	if truthy(data["title"]) {
		lines[0] = "pie title " + cleanLabel(data["title"])
	}
	for _, entry := range entries {
		value, ok := entry["value"].(float64)
		if !ok {
			return "", diagramError("valor de pie precisa ser numérico")
		}
		lines = append(lines, `    "`+cleanLabel(entry["label"])+`" : `+jsText(value))
	}
	return strings.Join(lines, "\n"), nil
}

func gantt(data map[string]any) (string, error) {
	sections := dataList(data["sections"])
	if len(sections) == 0 {
		return "", diagramError("gantt sem seções")
	}
	lines := []string{"gantt"}
	if truthy(data["title"]) {
		lines = append(lines, "    title "+cleanLabel(data["title"]))
	}
	format := jsText(data["dateLine"])
	if format == "" {
		format = "YYYY-MM-DD"
	}
	lines = append(lines, "    dateFormat "+format)
	for _, section := range sections {
		lines = append(lines, "    section "+cleanLabel(section["name"]))
		for _, task := range dataList(section["tasks"]) {
			status := strings.ToLower(jsText(task["status"]))
			prefix := ""
			if oneOf(status, []string{"done", "active", "crit", "milestone"}, "") != "" {
				prefix = status + ", "
			}
			start, end := jsText(task["start"]), jsText(task["end"])
			if end == "" {
				end = "1d"
			}
			description := cleanLabel(task["desc"])
			if truthy(task["id"]) {
				lines = append(lines, "    "+description+" : "+prefix+jsText(task["id"])+", "+start+", "+end)
			} else {
				lines = append(lines, "    "+description+" : "+prefix+start+", "+end)
			}
		}
	}
	return strings.Join(lines, "\n"), nil
}

func mindmap(data map[string]any) (string, error) {
	root := strings.TrimSpace(jsText(data["root"]))
	if root == "" {
		return "", diagramError("mindmap sem raiz")
	}
	lines := []string{"mindmap", "\troot((" + cleanLabel(root) + "))"}
	for _, node := range dataList(data["nodes"]) {
		level, ok := node["level"].(float64)
		if !ok || level != math.Trunc(level) || level < 1 {
			return "", diagramError("nó de mindmap precisa de level inteiro >= 1")
		}
		lines = append(lines, strings.Repeat("\t", int(level)+1)+cleanLabel(node["text"]))
	}
	return strings.Join(lines, "\n"), nil
}

var generators = map[string]func(map[string]any) (string, error){"flowchart": flowchart, "sequence": sequence, "class": classDiagram, "state": stateDiagram, "pie": pie, "gantt": gantt, "mindmap": mindmap}

// Diagram writes the Mermaid code of a diagram from its type and data (generateDiagram).
func Diagram(kind string, data any) (code string, err error) {
	generator, ok := generators[strings.ToLower(jsText(kind))]
	if !ok {
		return "", diagramError("tipo de diagrama não suportado: " + kind)
	}
	record, ok := data.(map[string]any)
	if !ok {
		return "", diagramError("dados do diagrama precisam ser um objeto JSON")
	}
	defer func() {
		if r := recover(); r != nil {
			code, err = "", errors.New(fmt.Sprint(r))
		}
	}()
	return generator(record)
}
