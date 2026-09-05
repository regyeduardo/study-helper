import json
import re

DIAGRAM_TYPES = ("flowchart", "sequence", "class", "state", "pie", "gantt", "mindmap")

_FLOWCHART_SHAPES = {
    "rounded": ("(", ")"),
    "stadium": ("([", "])"),
    "diam": ("{", "}"),
    "circle": ("((", "))"),
    "cyl": ("[(", ")]"),
    "hex": ("{{", "}}"),
    "parallelogram": ("[/", "/]"),
}

_LINK_STYLES = {
    "dotted": "-.->",
    "thick": "==>",
    "invisible": "~~~",
}

_SEQUENCE_ARROWS = {
    "solid": "->>",
    "dashed": "-->>",
    "dotted": "-x",
    "async": "->)",
}

_CLASS_RELATIONS = {
    "inheritance": "--|>",
    "composition": "--*",
    "aggregation": "--o",
    "association": "-->",
}


class DiagramError(ValueError):
    pass


def generate(diagram_type: str, data: dict) -> str:
    generator = _GENERATORS.get((diagram_type or "").lower())
    if generator is None:
        raise DiagramError(f"tipo de diagrama não suportado: {diagram_type}")
    if not isinstance(data, dict):
        raise DiagramError("dados do diagrama precisam ser um objeto JSON")
    return generator(data)


def extract_json(text: str) -> dict | None:
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = re.sub(r"^```[a-zA-Z]*\n?", "", stripped)
        stripped = re.sub(r"```$", "", stripped).strip()

    start = stripped.find("{")
    if start < 0:
        return None

    depth = 0
    for index in range(start, len(stripped)):
        char = stripped[index]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(stripped[start : index + 1])
                except json.JSONDecodeError:
                    return None
    return None


def _clean_label(text: str) -> str:
    return str(text).replace("(", " ").replace(")", " ").replace('"', "'").strip()


def _flowchart(data: dict) -> str:
    nodes = data.get("nodes") or []
    if not nodes:
        raise DiagramError("flowchart sem nós")

    direction = str(data.get("direction") or "TD").upper()
    if direction not in ("TD", "TB", "LR", "RL", "BT"):
        direction = "TD"

    lines = [f"flowchart {direction}"]
    lines.extend(_flowchart_node(node) for node in nodes)
    lines.extend(_flowchart_link(link) for link in data.get("links") or [])

    for subgraph in data.get("subgraphs") or []:
        lines.extend(_flowchart_subgraph(subgraph, ""))

    return "\n".join(lines)


def _flowchart_node(node: dict) -> str:
    node_id = str(node.get("id") or "").strip()
    if not node_id:
        raise DiagramError("nó de flowchart sem id")
    open_shape, close_shape = _FLOWCHART_SHAPES.get(str(node.get("shape") or "").lower(), ("[", "]"))
    return f'{node_id}{open_shape}"{_clean_label(node.get("text") or node_id)}"{close_shape}'


def _flowchart_link(link: dict, prefix: str = "") -> str:
    source = f"{prefix}{str(link.get('from') or '').strip()}"
    target = f"{prefix}{str(link.get('to') or '').strip()}"
    if not source.strip() or not target.strip():
        raise DiagramError("ligação de flowchart sem origem ou destino")

    if str(link.get("head") or "").lower() == "none":
        arrow = "---"
    else:
        arrow = _LINK_STYLES.get(str(link.get("shape") or "").lower(), "-->")

    text = link.get("text")
    if text and arrow != "~~~":
        return f"{source} {arrow}|{_clean_label(text)}| {target}"
    return f"{source} {arrow} {target}"


def _flowchart_subgraph(subgraph: dict, parent_prefix: str) -> list[str]:
    subgraph_id = str(subgraph.get("id") or "").strip()
    if not subgraph_id:
        raise DiagramError("subgraph sem id")

    prefix = f"{parent_prefix}{subgraph_id}_"
    title = _clean_label(subgraph.get("title") or subgraph_id)
    lines = [f"subgraph {subgraph_id}[{title}]"]

    for node in subgraph.get("nodes") or []:
        prefixed = dict(node)
        prefixed["id"] = f"{prefix}{node.get('id')}"
        lines.append(_flowchart_node(prefixed))

    for link in subgraph.get("links") or []:
        lines.append(_flowchart_link(link, prefix))

    for child in subgraph.get("children") or []:
        lines.extend(_flowchart_subgraph(child, prefix))

    lines.append("end")
    return lines


def _sequence(data: dict) -> str:
    actors = data.get("actors") or []
    if not actors:
        raise DiagramError("sequence sem atores")

    lines = ["sequenceDiagram"]
    if data.get("autonumber"):
        lines.append("    autonumber")

    for actor in actors:
        actor_id = str(actor.get("id") or "").strip()
        if not actor_id:
            raise DiagramError("ator de sequence sem id")
        keyword = "actor" if str(actor.get("type") or "").lower() == "actor" else "participant"
        name = actor.get("name")
        if name and name != actor_id:
            lines.append(f"    {keyword} {actor_id} as {_clean_label(name)}")
        else:
            lines.append(f"    {keyword} {actor_id}")

    for message in data.get("messages") or []:
        source = str(message.get("from") or "").strip()
        target = str(message.get("to") or "").strip()
        if not source or not target:
            raise DiagramError("mensagem de sequence sem origem ou destino")
        arrow = _SEQUENCE_ARROWS.get(str(message.get("type") or "").lower(), "->>")
        lines.append(f"    {source}{arrow}{target}: {_clean_label(message.get('text') or '')}")

    return "\n".join(lines)


def _class(data: dict) -> str:
    classes = data.get("classes") or []
    if not classes:
        raise DiagramError("class diagram sem classes")

    direction = str(data.get("direction") or "TB").upper()
    if direction not in ("TB", "LR", "RL", "BT"):
        direction = "TB"

    lines = ["classDiagram", f"direction {direction}"]

    for item in classes:
        name = str(item.get("name") or "").strip()
        if not name:
            raise DiagramError("classe sem nome")
        body: list[str] = []
        for member in item.get("members") or []:
            visibility = member.get("visibility") or "+"
            body.append(f"    {visibility}{member.get('type', '')} {member.get('name', '')}".rstrip())
        for method in item.get("methods") or []:
            visibility = method.get("visibility") or "+"
            params = ", ".join(
                f"{param.get('type', '')} {param.get('name', '')}".strip()
                for param in method.get("parameters") or []
            )
            return_type = method.get("return_type") or ""
            suffix = f" {return_type}" if return_type else ""
            body.append(f"    {visibility}{method.get('name', '')}({params}){suffix}")

        if body:
            lines.append(f"class {name} {{")
            lines.extend(body)
            lines.append("}")
        else:
            lines.append(f"class {name}")

    for relation in data.get("relations") or []:
        source = str(relation.get("from") or "").strip()
        target = str(relation.get("to") or "").strip()
        if not source or not target:
            raise DiagramError("relação de classe sem origem ou destino")
        arrow = _CLASS_RELATIONS.get(str(relation.get("type") or "").lower(), "-->")
        label = relation.get("label")
        if label:
            lines.append(f"{source} {arrow} {target} : {_clean_label(label)}")
        else:
            lines.append(f"{source} {arrow} {target}")

    return "\n".join(lines)


def _state(data: dict) -> str:
    states = data.get("states") or []
    if not states:
        raise DiagramError("state diagram sem estados")

    lines = ["stateDiagram-v2"]
    known: set[str] = set()

    for state in states:
        state_id = str(state.get("id") or "").strip()
        if not state_id:
            raise DiagramError("estado sem id")
        known.add(state_id)
        description = state.get("description")
        if description:
            lines.append(f"    {state_id} : {_clean_label(description)}")
        else:
            lines.append(f"    {state_id}")

    for transition in data.get("transitions") or []:
        source = str(transition.get("from") or "").strip()
        target = str(transition.get("to") or "").strip()
        if source not in known or target not in known:
            continue
        description = transition.get("description")
        if description:
            lines.append(f"    {source} --> {target} : {_clean_label(description)}")
        else:
            lines.append(f"    {source} --> {target}")

    return "\n".join(lines)


def _pie(data: dict) -> str:
    entries = data.get("data") or []
    if not entries:
        raise DiagramError("pie sem dados")

    title = data.get("title")
    lines = [f"pie title {_clean_label(title)}"] if title else ["pie"]
    for entry in entries:
        value = entry.get("value")
        if not isinstance(value, (int, float)):
            raise DiagramError("valor de pie precisa ser numérico")
        lines.append(f'    "{_clean_label(entry.get("label") or "")}" : {value}')
    return "\n".join(lines)


def _gantt(data: dict) -> str:
    sections = data.get("sections") or []
    if not sections:
        raise DiagramError("gantt sem seções")

    lines = ["gantt"]
    if data.get("title"):
        lines.append(f"    title {_clean_label(data['title'])}")
    lines.append(f"    dateFormat {data.get('dateLine') or 'YYYY-MM-DD'}")

    for section in sections:
        lines.append(f"    section {_clean_label(section.get('name') or '')}")
        for task in section.get("tasks") or []:
            status = str(task.get("status") or "").lower()
            prefix = f"{status}, " if status in ("done", "active", "crit", "milestone") else ""
            start = task.get("start") or ""
            end = task.get("end") or "1d"
            description = _clean_label(task.get("desc") or "")
            task_id = task.get("id")
            if task_id:
                lines.append(f"    {description} : {prefix}{task_id}, {start}, {end}")
            else:
                lines.append(f"    {description} : {prefix}{start}, {end}")

    return "\n".join(lines)


def _mindmap(data: dict) -> str:
    root = str(data.get("root") or "").strip()
    if not root:
        raise DiagramError("mindmap sem raiz")

    lines = ["mindmap", f"\troot(({_clean_label(root)}))"]
    for node in data.get("nodes") or []:
        level = node.get("level")
        if not isinstance(level, int) or level < 1:
            raise DiagramError("nó de mindmap precisa de level inteiro >= 1")
        lines.append("\t" * (level + 1) + _clean_label(node.get("text") or ""))
    return "\n".join(lines)


_GENERATORS = {
    "flowchart": _flowchart,
    "sequence": _sequence,
    "class": _class,
    "state": _state,
    "pie": _pie,
    "gantt": _gantt,
    "mindmap": _mindmap,
}
