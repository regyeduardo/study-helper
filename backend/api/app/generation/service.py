import logging
from datetime import timedelta
from pathlib import Path
from typing import Optional

from sqlmodel import Session

from app import errors
from app.db import engine
from app.files.service import get_file, lineage
from app.generation import deepseek, pipeline, prompts, uploads
from app.questions.schemas import QuestionWrite
from app.questions.service import replace_for_file
from app.shared.enums import FileType, TempFileStatus
from app.shared.ids import utc_now
from app.temp_files.models import TempFile
from app.temp_files.schemas import TempFileCreate
from app.temp_files.service import create_temp_file, get_temp_file

logger = logging.getLogger(__name__)

MAX_QUESTION_INPUT_CHARS = 12000
LINEAGE_CONTEXT_CHARS = 1200


def temp_file_name(title: str) -> str:
    stamp = (utc_now() - timedelta(hours=3)).strftime("%Y-%m-%d %H:%M:%S")
    return f"{stamp} - {title or 'conteudo'}"


def start_temp_file(
    session: Session,
    title: str,
    file_type: FileType,
    description: str = "",
    parent_file_id: Optional[str] = None,
    source_excerpt: Optional[str] = None,
) -> TempFile:
    return create_temp_file(
        session,
        TempFileCreate(
            name=temp_file_name(title),
            content="",
            content_type="markdown",
            type=file_type,
            description=description,
            status=TempFileStatus.generating,
            parent_file_id=parent_file_id,
            source_excerpt=source_excerpt,
        ),
    )


def finish_temp_file(temp_file_id: str, content: str, status: TempFileStatus) -> None:
    with Session(engine) as session:
        temp_file = session.get(TempFile, temp_file_id)
        if temp_file is None:
            return
        temp_file.content = content
        temp_file.status = status
        session.add(temp_file)
        session.commit()


def read_upload(
    filename: str,
    payload: bytes,
    language: str,
    prompt: str,
    transcription_provider: str = "",
) -> str:
    kind = uploads.detect_kind(filename, payload)

    if kind == "pdf":
        text = _pdf_text(payload)
    elif kind == "docx":
        text = _docx_text(payload)
    elif kind == "doc_legacy":
        raise errors.bad_request("Formato .doc antigo não é suportado — salve como .docx e envie de novo.")
    elif kind == "subtitle":
        text = uploads.subtitle_to_text(uploads.decode(payload))
    elif kind == "media":
        text = _transcribe(filename, payload, language, transcription_provider=transcription_provider)
    else:
        text = uploads.decode(payload).strip()

    if prompt:
        text = f"{text}\n\n{prompt}"
    return f"# Conteúdo\n\n{text}"


def _pdf_text(payload: bytes) -> str:
    import io

    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(payload))
    return "\n\n".join((page.extract_text() or "").strip() for page in reader.pages).strip()


def _docx_text(payload: bytes) -> str:
    import io

    from docx import Document

    document = Document(io.BytesIO(payload))
    return "\n\n".join(p.text.strip() for p in document.paragraphs if p.text.strip())


def _transcribe(filename: str, payload: bytes, language: str, transcription_provider: str = "") -> str:
    import tempfile

    from app.transcription.service import transcribe

    suffix = Path(filename or "audio").suffix
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as handle:
        handle.write(payload)
        temp_path = Path(handle.name)
    try:
        return transcribe(temp_path, language=language, provider=transcription_provider)
    finally:
        temp_path.unlink(missing_ok=True)


def build_selection_input(session: Session, file_id: str, excerpt: str, user_prompt: str) -> tuple[str, str]:
    file = get_file(session, file_id)

    if user_prompt.strip():
        content = f"Trecho selecionado:\n\n{excerpt}\n\nInstrução:\n\n{user_prompt.strip()}"
        return content, file.name

    steps = lineage(session, file_id)
    origin_lines = [f"Documento de origem: {file.name}"]
    for step in steps:
        origin_lines.append(f"Veio de: {step.name}")

    context = file.content[:LINEAGE_CONTEXT_CHARS]
    content = (
        f"{chr(10).join(origin_lines)}\n\n"
        f"Contexto do documento:\n\n{context}\n\n"
        f"Explique o trecho abaixo, considerando de onde ele veio:\n\n{excerpt}"
    )
    return content, file.name


def generate_questions(markdown: str, title: str, file_type: str) -> tuple[list[dict], str]:
    trimmed = _truncate_for_questions(markdown)

    prep = deepseek.chat(f"# {title}\n\n{trimmed}", prompts.QUESTIONS_PREP_PROMPT).strip()
    if not prep:
        prep = trimmed

    raw = deepseek.chat(f"# {title}\n\n{prep}", prompts.EXAM_PROMPT)
    return pipeline.extract_questions(raw)


def generate_reading_exam(content: str, title: str) -> tuple[list[dict], str]:
    raw = deepseek.chat(f"# {title}\n\n{content}", prompts.READING_EXAM_PROMPT)
    return pipeline.extract_questions(raw)


def persist_questions(file_id: str, questions: list[dict]) -> None:
    payload: list[QuestionWrite] = []
    for question in questions:
        alternatives = question.get("alternativas") or {}
        try:
            payload.append(
                QuestionWrite(
                    statement=question.get("enunciado", ""),
                    alternative_a=alternatives.get("A", ""),
                    alternative_b=alternatives.get("B", ""),
                    alternative_c=alternatives.get("C", ""),
                    alternative_d=alternatives.get("D", ""),
                    alternative_e=alternatives.get("E", ""),
                    right_alternative=question.get("correta", "A"),
                    explanation=question.get("explicacao"),
                    diagram=question.get("diagrama") or None,
                )
            )
        except ValueError:
            logger.warning("Questão inválida ignorada ao persistir para o arquivo %s", file_id)

    if not payload:
        return

    with Session(engine) as session:
        replace_for_file(session, file_id, payload)


def temp_file_source(session: Session, temp_file_id: str) -> TempFile:
    return get_temp_file(session, temp_file_id)


def _truncate_for_questions(markdown: str) -> str:
    if len(markdown) <= MAX_QUESTION_INPUT_CHARS:
        return markdown

    cut = markdown.rfind("\n## ", 0, MAX_QUESTION_INPUT_CHARS)
    if cut < 0:
        cut = MAX_QUESTION_INPUT_CHARS
    return markdown[:cut].strip()
