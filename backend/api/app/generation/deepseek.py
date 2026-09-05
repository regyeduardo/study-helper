import json
import logging
from datetime import datetime
from pathlib import Path

import httpx

from app import config
from app.errors import GenerationError

logger = logging.getLogger(__name__)

REQUEST_TIMEOUT = 600.0
MAX_TOKENS = 16384
TEMPERATURE = 0.7

FIXTURE_DIR = Path(__file__).resolve().parents[2] / "testdata" / "fixtures" / "deepseek"

_FIXTURES = {
    "Agente Aula": "lesson_response_01.json",
    "Agente Explicação": "explanation_response_01.json",
    "gera dados de diagrama": "diagram_response_01.json",
    "prepara material para geração de provas": "questions_prep_response_01.json",
    "gerador de provas de compreensão de leitura": "reading_exam_response_01.json",
    "gerador de provas": "exam_response_01.json",
}


def is_available() -> bool:
    return bool(config.deepseek_api_key())


def model_name() -> str:
    return config.deepseek_model()


def chat(content: str, system_prompt: str) -> str:
    if config.test_mode():
        return _load_fixture(system_prompt)

    api_key = config.deepseek_api_key()
    if not api_key:
        raise GenerationError("DEEPSEEK_API_KEY não configurada.")

    payload = {
        "model": config.deepseek_model(),
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": content},
        ],
        "temperature": TEMPERATURE,
        "max_tokens": MAX_TOKENS,
    }

    with httpx.Client(timeout=REQUEST_TIMEOUT) as client:
        response = client.post(
            f"{config.deepseek_base_url().rstrip('/')}/chat/completions",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json=payload,
        )

    if response.status_code != 200:
        raise GenerationError(f"DeepSeek retornou {response.status_code}: {response.text[:500]}")

    choices = response.json().get("choices") or []
    if not choices:
        return ""
    return choices[0].get("message", {}).get("content", "")


def save_debug_markdown(markdown: str) -> None:
    if not config.debug_output():
        return
    directory = Path(config.debug_output_dir())
    directory.mkdir(parents=True, exist_ok=True)
    name = f"lesson-{datetime.now().strftime('%Y%m%d-%H%M%S')}.md"
    (directory / name).write_text(markdown, encoding="utf-8")


def _load_fixture(system_prompt: str) -> str:
    for marker, filename in _FIXTURES.items():
        if marker in system_prompt:
            path = FIXTURE_DIR / filename
            if not path.exists():
                raise GenerationError(f"Fixture não encontrada: {path}")
            payload = json.loads(path.read_text(encoding="utf-8"))
            choices = payload.get("choices") or []
            return choices[0]["message"]["content"] if choices else ""
    raise GenerationError("Nenhuma fixture corresponde ao prompt informado.")
