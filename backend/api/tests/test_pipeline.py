import json

import pytest

from app.errors import GenerationError
from app.generation import deepseek, pipeline

LESSON_JSON = json.dumps(
    {
        "markdown": {
            "elements": [
                {"type": "heading", "level": 1, "text": "Aula"},
                {"type": "diagram", "diagramIndex": 0},
            ],
            "diagrams": [{"type": "flowchart", "hint": "fluxo simples do processo"}],
        }
    }
)

DIAGRAM_JSON = json.dumps(
    {"nodes": [{"id": "a", "text": "Início"}, {"id": "b", "text": "Fim"}], "links": [{"from": "a", "to": "b"}]}
)


def fake_chat(responses):
    calls = iter(responses)

    def _chat(content: str, system_prompt: str) -> str:
        return next(calls)

    return _chat


def test_generate_content_runs_both_phases(monkeypatch):
    monkeypatch.setattr(deepseek, "chat", fake_chat([LESSON_JSON, DIAGRAM_JSON]))
    monkeypatch.setattr(pipeline.deepseek, "chat", fake_chat([LESSON_JSON, DIAGRAM_JSON]))

    events = []
    markdown = pipeline.generate_content("conteúdo", "prompt", lambda event, data: events.append(event))

    assert "# Aula" in markdown
    assert "```mermaid" in markdown
    assert events == ["phase1_complete", "diagram_ready", "lesson_complete"]


def test_falls_back_to_table_when_diagram_fails(monkeypatch):
    responses = [LESSON_JSON] + ["sem json"] * pipeline.PHASE2_MAX_RETRIES
    monkeypatch.setattr(pipeline.deepseek, "chat", fake_chat(responses))

    events = []
    markdown = pipeline.generate_content("conteúdo", "prompt", lambda event, data: events.append(event))

    assert "| Conceito | Descrição |" in markdown
    assert "diagram_fallback" in events


def test_retries_phase_one_until_valid(monkeypatch):
    monkeypatch.setattr(pipeline.deepseek, "chat", fake_chat(["{}", LESSON_JSON, DIAGRAM_JSON]))
    markdown = pipeline.generate_content("conteúdo", "prompt")
    assert "# Aula" in markdown


def test_raises_after_max_retries(monkeypatch):
    monkeypatch.setattr(pipeline.deepseek, "chat", fake_chat(["nada"] * pipeline.PHASE1_MAX_RETRIES))
    with pytest.raises(GenerationError):
        pipeline.generate_content("conteúdo", "prompt")


def test_extract_questions_from_plain_json():
    questions, _ = pipeline.extract_questions('{"questions": [{"id": 1}]}')
    assert len(questions) == 1


def test_extract_questions_from_fenced_json():
    questions, _ = pipeline.extract_questions('```json\n{"questions": [{"id": 1}, {"id": 2}]}\n```')
    assert len(questions) == 2


def test_extract_questions_returns_raw_when_invalid():
    questions, raw = pipeline.extract_questions("resposta livre")
    assert questions == []
    assert raw == "resposta livre"
