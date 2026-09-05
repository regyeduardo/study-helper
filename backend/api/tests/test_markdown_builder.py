import pytest

from app.generation.markdown_builder import (
    LessonValidationError,
    build_markdown,
    validate_lesson,
)


def test_validate_accepts_minimal_lesson():
    elements, diagrams = validate_lesson(
        {"markdown": {"elements": [{"type": "heading", "level": 1, "text": "Título"}], "diagrams": []}}
    )
    assert len(elements) == 1
    assert diagrams == []


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"markdown": {"elements": []}},
        {"markdown": {"elements": [{"type": "desconhecido"}]}},
        {"markdown": {"elements": [{"type": "heading", "text": "x"}]}},
        {"markdown": {"elements": [{"type": "paragraph", "text": ""}]}},
        {"markdown": {"elements": [{"type": "table", "headers": ["a"]}]}},
        {"markdown": {"elements": [{"type": "diagram", "diagramIndex": 3}], "diagrams": []}},
        {
            "markdown": {
                "elements": [{"type": "paragraph", "text": "ok"}],
                "diagrams": [{"type": "radar", "hint": "x"}],
            }
        },
    ],
)
def test_validate_rejects_broken_payloads(payload):
    with pytest.raises(LessonValidationError):
        validate_lesson(payload)


def test_build_renders_every_element_type():
    elements = [
        {"type": "heading", "level": 2, "text": "Seção"},
        {"type": "paragraph", "text": "Texto simples."},
        {"type": "bulletedList", "items": ["um", "dois"]},
        {"type": "orderedList", "items": ["primeiro"]},
        {"type": "checklist", "checkItems": [{"checked": True, "text": "feito"}]},
        {"type": "blockquote", "text": "citação"},
        {"type": "codeBlock", "language": "python", "text": "print(1)"},
        {"type": "table", "headers": ["A", "B"], "rows": [["1", "2"]]},
        {"type": "alert", "style": "tip", "text": "dica"},
        {"type": "horizontalRule"},
        {"type": "details", "summary": "mais", "text": "detalhe"},
    ]

    markdown = build_markdown(elements)

    assert "## Seção" in markdown
    assert "- um" in markdown
    assert "1. primeiro" in markdown
    assert "- [x] feito" in markdown
    assert "> citação" in markdown
    assert "```python" in markdown
    assert "| A | B |" in markdown
    assert "> [!TIP]" in markdown
    assert "<details><summary>mais</summary>" in markdown


def test_build_uses_placeholders_for_diagrams():
    elements = [{"type": "diagram", "diagramIndex": 0}]
    assert "<!-- diagram:0 -->" in build_markdown(elements, placeholders=True)


def test_build_inlines_resolved_mermaid_and_table():
    elements = [{"type": "diagram", "diagramIndex": 0}, {"type": "diagram", "diagramIndex": 1}]
    markdown = build_markdown(elements, ["flowchart TD\na[b]", "| Conceito | Descrição |"])

    assert "```mermaid" in markdown
    assert "| Conceito | Descrição |" in markdown


def test_build_strips_external_links_from_output():
    elements = [{"type": "paragraph", "text": "veja [aqui](https://exemplo.com)"}]
    assert "https://exemplo.com" not in build_markdown(elements)
