import json
import logging
from collections.abc import Callable
from typing import Any

from app.errors import GenerationError
from app.generation import deepseek, mermaid
from app.generation.diagram_prompt import build_context, diagram_prompt
from app.generation.markdown_builder import (
    LessonValidationError,
    build_markdown,
    read_suggestion,
    validate_lesson,
)
from app.generation.prompts import DIAGRAM_PROMPT
from app.generation.table_fallback import table_fallback

logger = logging.getLogger(__name__)

PHASE1_MAX_RETRIES = 5
PHASE2_MAX_RETRIES = 3

Emit = Callable[[str, Any], None]


def _noop(event: str, data: Any) -> None:
    return None


def generate_content(content: str, system_prompt: str, emit: Emit = _noop) -> str:
    elements, diagrams, suggestion = _phase_one(content, system_prompt)

    emit("phase1_complete", build_markdown(elements, placeholders=True))
    if suggestion:
        emit("suggestion", suggestion)

    resolved = _phase_two(elements, diagrams, emit)

    markdown = build_markdown(elements, resolved)
    emit("lesson_complete", markdown)
    deepseek.save_debug_markdown(markdown)
    return markdown


def _phase_one(content: str, system_prompt: str) -> tuple[list[dict], list[dict], dict]:
    last_error = ""

    for _ in range(PHASE1_MAX_RETRIES):
        prompt = system_prompt
        if last_error:
            prompt = (
                f"[Auto-Correção]\nErro na tentativa anterior: {last_error}\n"
                f"--- PROMPT ORIGINAL (não modificar) ---\n{system_prompt}"
            )

        raw = deepseek.chat(content, prompt)
        payload = mermaid.extract_json(raw)
        if payload is None:
            last_error = "resposta da IA não contém JSON válido"
            continue

        try:
            elements, diagrams = validate_lesson(payload)
            return elements, diagrams, read_suggestion(payload)
        except LessonValidationError as error:
            last_error = str(error)

    raise GenerationError(f"Geração falhou após {PHASE1_MAX_RETRIES} tentativas: {last_error}")


def _phase_two(elements: list[dict], diagrams: list[dict], emit: Emit) -> list[str]:
    resolved: list[str] = []

    for slot_index, slot in enumerate(diagrams):
        element_index = _element_index_for_slot(elements, slot_index)
        context = build_context(elements, element_index)
        previous_error = ""
        content = None

        for _ in range(PHASE2_MAX_RETRIES):
            prompt = diagram_prompt(slot["type"], slot["hint"], context, previous_error)
            try:
                raw = deepseek.chat(prompt, DIAGRAM_PROMPT)
            except GenerationError as error:
                previous_error = str(error)
                continue

            data = mermaid.extract_json(raw)
            if data is None:
                previous_error = f"resposta sem JSON válido para o diagrama {slot['type']}"
                continue

            try:
                content = mermaid.generate(slot["type"], data)
                break
            except mermaid.DiagramError as error:
                previous_error = str(error)

        if content is None:
            content = table_fallback(slot["hint"])
            resolved.append(content)
            emit("diagram_fallback", {"index": slot_index, "table": content})
        else:
            resolved.append(content)
            emit("diagram_ready", {"index": slot_index, "mermaid": content})

    return resolved


def _element_index_for_slot(elements: list[dict], slot_index: int) -> int:
    for index, element in enumerate(elements):
        if element.get("type") == "diagram" and element.get("diagramIndex") == slot_index:
            return index
    return -1


def extract_questions(raw: str) -> tuple[list[dict], str]:
    text = raw.strip()

    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        payload = mermaid.extract_json(text)

    if not isinstance(payload, dict):
        return [], raw

    questions = payload.get("questions")
    if not isinstance(questions, list):
        return [], raw
    return questions, raw
