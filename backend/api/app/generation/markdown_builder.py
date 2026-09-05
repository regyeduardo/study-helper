from app.generation.links import strip_external_links
from app.generation.mermaid import DIAGRAM_TYPES

ELEMENT_TYPES = {
    "heading",
    "paragraph",
    "bulletedList",
    "orderedList",
    "checklist",
    "blockquote",
    "codeBlock",
    "table",
    "alert",
    "horizontalRule",
    "details",
    "diagram",
}

_ALERT_STYLES = {"note": "NOTE", "tip": "TIP", "important": "IMPORTANT", "warning": "WARNING", "caution": "CAUTION"}


class LessonValidationError(ValueError):
    pass


def read_suggestion(payload: dict) -> dict:
    suggestion = payload.get("suggestion")
    if not isinstance(suggestion, dict):
        return {}
    name = str(suggestion.get("name") or "").strip()
    folder = str(suggestion.get("folder") or "").strip()
    return {"name": name, "folder": folder} if name or folder else {}


def validate_lesson(payload: dict) -> tuple[list[dict], list[dict]]:
    markdown = payload.get("markdown")
    if not isinstance(markdown, dict):
        raise LessonValidationError("resposta sem o objeto 'markdown'")

    elements = markdown.get("elements")
    if not isinstance(elements, list) or not elements:
        raise LessonValidationError("'elements' vazio ou ausente")

    diagrams = markdown.get("diagrams") or []
    if not isinstance(diagrams, list):
        raise LessonValidationError("'diagrams' precisa ser uma lista")

    for index, element in enumerate(elements):
        if not isinstance(element, dict):
            raise LessonValidationError(f"elemento[{index}] não é um objeto")
        element_type = element.get("type")
        if element_type not in ELEMENT_TYPES:
            raise LessonValidationError(f"elemento[{index}] tem tipo desconhecido: {element_type!r}")
        _validate_element(index, element, diagrams)

    for index, diagram in enumerate(diagrams):
        if not isinstance(diagram, dict):
            raise LessonValidationError(f"diagrama[{index}] não é um objeto")
        if diagram.get("type") not in DIAGRAM_TYPES:
            raise LessonValidationError(f"diagrama[{index}] tem tipo inválido: {diagram.get('type')!r}")
        if not str(diagram.get("hint") or "").strip():
            raise LessonValidationError(f"diagrama[{index}] está sem 'hint'")

    return elements, diagrams


def _validate_element(index: int, element: dict, diagrams: list) -> None:
    element_type = element["type"]

    if element_type == "heading":
        if not str(element.get("text") or "").strip():
            raise LessonValidationError(f"elemento[{index}] (heading) sem 'text'")
        level = element.get("level")
        if not isinstance(level, int) or not 1 <= level <= 6:
            raise LessonValidationError(f"elemento[{index}] (heading) precisa de 'level' entre 1 e 6")

    elif element_type in ("paragraph", "blockquote", "codeBlock"):
        if not str(element.get("text") or "").strip():
            raise LessonValidationError(f"elemento[{index}] ({element_type}) sem 'text'")

    elif element_type in ("bulletedList", "orderedList"):
        if not element.get("items"):
            raise LessonValidationError(f"elemento[{index}] ({element_type}) sem 'items'")

    elif element_type == "checklist":
        if not element.get("checkItems"):
            raise LessonValidationError(f"elemento[{index}] (checklist) sem 'checkItems'")

    elif element_type == "table":
        if not element.get("headers"):
            raise LessonValidationError(f"elemento[{index}] (table) sem 'headers'")
        if not element.get("rows"):
            raise LessonValidationError(f"elemento[{index}] (table) sem 'rows'")

    elif element_type == "alert":
        if not str(element.get("text") or "").strip():
            raise LessonValidationError(f"elemento[{index}] (alert) sem 'text'")

    elif element_type == "details":
        if not str(element.get("summary") or "").strip():
            raise LessonValidationError(f"elemento[{index}] (details) sem 'summary'")
        if not str(element.get("text") or "").strip():
            raise LessonValidationError(f"elemento[{index}] (details) sem 'text'")

    elif element_type == "diagram":
        diagram_index = element.get("diagramIndex")
        if not isinstance(diagram_index, int) or not 0 <= diagram_index < len(diagrams):
            raise LessonValidationError(
                f"elemento[{index}] (diagram) tem diagramIndex fora dos limites: {diagram_index!r}"
            )


def build_markdown(elements: list[dict], resolved: list[str] | None = None, placeholders: bool = False) -> str:
    blocks: list[str] = []

    for element in elements:
        if element["type"] == "diagram":
            blocks.append(_render_diagram(element, resolved, placeholders))
            continue
        blocks.append(_render_element(element))

    return strip_external_links("\n\n".join(block for block in blocks if block).strip() + "\n")


def _render_diagram(element: dict, resolved: list[str] | None, placeholders: bool) -> str:
    index = element.get("diagramIndex", 0)
    if placeholders or resolved is None:
        return f"<!-- diagram:{index} -->"
    if index >= len(resolved):
        return ""
    content = resolved[index]
    if content.lstrip().startswith("|"):
        return content
    return f"```mermaid\n{content}\n```"


def _render_element(element: dict) -> str:
    element_type = element["type"]

    if element_type == "heading":
        return f"{'#' * element['level']} {element['text']}"

    if element_type == "paragraph":
        return element["text"]

    if element_type == "bulletedList":
        return "\n".join(f"- {item}" for item in element["items"])

    if element_type == "orderedList":
        return "\n".join(f"{position}. {item}" for position, item in enumerate(element["items"], start=1))

    if element_type == "checklist":
        return "\n".join(
            f"- [{'x' if item.get('checked') else ' '}] {item.get('text', '')}"
            for item in element["checkItems"]
        )

    if element_type == "blockquote":
        return "\n".join(f"> {line}" for line in str(element["text"]).split("\n"))

    if element_type == "codeBlock":
        language = element.get("language") or ""
        return f"```{language}\n{element['text']}\n```"

    if element_type == "table":
        return _render_table(element)

    if element_type == "alert":
        style = _ALERT_STYLES.get(str(element.get("style") or "note").lower(), "NOTE")
        body = "\n".join(f"> {line}" for line in str(element["text"]).split("\n"))
        return f"> [!{style}]\n{body}"

    if element_type == "horizontalRule":
        return "---"

    if element_type == "details":
        return f"<details><summary>{element['summary']}</summary>\n\n{element['text']}\n\n</details>"

    return ""


def _render_table(element: dict) -> str:
    headers = [str(header) for header in element["headers"]]
    lines = ["| " + " | ".join(headers) + " |", "|" + "|".join(["---"] * len(headers)) + "|"]
    for row in element["rows"]:
        cells = [str(cell) for cell in row]
        cells += [""] * (len(headers) - len(cells))
        lines.append("| " + " | ".join(cells[: len(headers)]) + " |")
    return "\n".join(lines)
