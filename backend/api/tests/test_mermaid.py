import pytest

from app.generation import mermaid


def test_flowchart_renders_nodes_and_links():
    result = mermaid.generate(
        "flowchart",
        {
            "direction": "LR",
            "nodes": [{"id": "a", "text": "Início", "shape": "rounded"}, {"id": "b", "text": "Fim"}],
            "links": [{"from": "a", "to": "b", "text": "segue"}],
        },
    )
    assert result.startswith("flowchart LR")
    assert 'a("Início")' in result
    assert "a -->|segue| b" in result


def test_flowchart_strips_parentheses_from_labels():
    result = mermaid.generate(
        "flowchart",
        {"nodes": [{"id": "a", "text": "Agente (local)"}], "links": []},
    )
    assert "(" not in result.split("\n")[1].split('"')[1]


def test_flowchart_subgraph_prefixes_nodes():
    result = mermaid.generate(
        "flowchart",
        {
            "nodes": [{"id": "root", "text": "Raiz"}],
            "links": [],
            "subgraphs": [
                {"id": "grupo", "title": "Grupo", "nodes": [{"id": "x", "text": "X"}], "links": []}
            ],
        },
    )
    assert "subgraph grupo[Grupo]" in result
    assert "grupo_x" in result
    assert result.strip().endswith("end")


def test_sequence_uses_arrow_types():
    result = mermaid.generate(
        "sequence",
        {
            "actors": [{"id": "cli", "name": "Cliente", "type": "actor"}, {"id": "srv", "name": "srv"}],
            "messages": [
                {"from": "cli", "to": "srv", "text": "pede"},
                {"from": "srv", "to": "cli", "text": "responde", "type": "dashed"},
            ],
        },
    )
    assert "sequenceDiagram" in result
    assert "actor cli as Cliente" in result
    assert "cli->>srv: pede" in result
    assert "srv-->>cli: responde" in result


def test_class_diagram_with_members_and_relation():
    result = mermaid.generate(
        "class",
        {
            "classes": [
                {
                    "name": "Animal",
                    "members": [{"name": "nome", "type": "String", "visibility": "+"}],
                    "methods": [{"name": "falar", "return_type": "void"}],
                },
                {"name": "Cachorro"},
            ],
            "relations": [{"from": "Cachorro", "to": "Animal", "type": "inheritance"}],
        },
    )
    assert "classDiagram" in result
    assert "+String nome" in result
    assert "Cachorro --|> Animal" in result


def test_state_ignores_unknown_transitions():
    result = mermaid.generate(
        "state",
        {
            "states": [{"id": "a", "description": "A"}, {"id": "b", "description": "B"}],
            "transitions": [{"from": "a", "to": "b"}, {"from": "a", "to": "zzz"}],
        },
    )
    assert "a --> b" in result
    assert "zzz" not in result


def test_pie_and_gantt_and_mindmap():
    pie = mermaid.generate("pie", {"title": "Uso", "data": [{"label": "Go", "value": 40}]})
    assert pie.startswith("pie title Uso")
    assert '"Go" : 40' in pie

    gantt = mermaid.generate(
        "gantt",
        {"title": "Plano", "sections": [{"name": "Fase", "tasks": [{"desc": "Análise", "start": "2026-01-01", "end": "2026-01-05"}]}]},
    )
    assert gantt.startswith("gantt")
    assert "section Fase" in gantt

    mindmap = mermaid.generate("mindmap", {"root": "Base", "nodes": [{"text": "Filho", "level": 1}]})
    assert mindmap.startswith("mindmap")
    assert "\troot((Base))" in mindmap
    assert "\t\tFilho" in mindmap


def test_unknown_type_raises():
    with pytest.raises(mermaid.DiagramError):
        mermaid.generate("radar", {})


def test_missing_required_data_raises():
    with pytest.raises(mermaid.DiagramError):
        mermaid.generate("flowchart", {"nodes": []})


def test_extract_json_handles_fenced_response():
    assert mermaid.extract_json('```json\n{"a": 1}\n```') == {"a": 1}


def test_extract_json_returns_none_without_json():
    assert mermaid.extract_json("sem json aqui") is None
