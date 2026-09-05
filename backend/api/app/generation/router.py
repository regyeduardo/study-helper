from typing import Any, Callable, Optional

from fastapi import APIRouter, Depends, File, Form, UploadFile
from fastapi.responses import StreamingResponse
from sqlmodel import Session

from app import errors
from app.db import engine, get_session
from app.generation import pipeline, prompts, service, sse
from app.generation.schemas import (
    ExplanationRequest,
    LessonRequest,
    LessonResult,
    MarkdownResult,
    QuestionsRequest,
    QuestionsResult,
    ReadingExamRequest,
    RegenerationRequest,
)
from app.shared.enums import FileType, TempFileStatus
from app.sources.service import fetch_content

router = APIRouter(prefix="/generations", tags=["generations"])

AGENTS = {
    "lesson": (FileType.class_, prompts.lesson_prompt),
    "explanation": (FileType.explanation, prompts.explanation_prompt),
    "meeting": (FileType.meeting, prompts.meeting_prompt),
}

# Regeneration read the note's type from nowhere and always rebuilt it as a lesson,
# so an ata came back rewritten as an aula.
PROMPT_POR_TIPO = {tipo: constroi for tipo, constroi in AGENTS.values()}


@router.post("/lessons", response_model=LessonResult)
def generate_lesson(data: LessonRequest, session: Session = Depends(get_session)):
    if not data.content.strip():
        raise errors.bad_request("Parâmetro 'content' é obrigatório.")

    title = data.title or "Aula"
    temp_file = service.start_temp_file(session, title, FileType.class_)

    try:
        markdown = pipeline.generate_content(
            f"# {title}\n\n{data.content}", prompts.lesson_prompt()
        )
    except Exception as error:  # noqa: BLE001
        service.finish_temp_file(temp_file.id, "", TempFileStatus.error)
        raise errors.internal(str(error))

    service.finish_temp_file(temp_file.id, markdown, TempFileStatus.complete)
    return LessonResult(markdown=markdown, temp_file_id=temp_file.id)


@router.post("/regenerations", response_model=MarkdownResult)
def regenerate(data: RegenerationRequest):
    if not data.content.strip():
        raise errors.bad_request("Parâmetro 'content' é obrigatório.")

    title = data.title or "Conteúdo"
    try:
        markdown = pipeline.generate_content(
            f"# {title}\n\n{data.content}",
            PROMPT_POR_TIPO.get(data.type, prompts.lesson_prompt)(),
        )
    except Exception as error:  # noqa: BLE001
        raise errors.internal(str(error))
    return MarkdownResult(markdown=markdown)


def _has_some_input(agent: str, url: str, topic: str, source_file_id: str, upload_name: str) -> bool:
    if agent == "explanation" and topic.strip():
        return True
    if agent == "explanation" and source_file_id:
        return True
    if url.strip():
        return True
    return bool(upload_name)


@router.post("/stream")
async def generate_stream(
    agent: str = Form("lesson"),
    url: str = Form(""),
    topic: str = Form(""),
    prompt: str = Form(""),
    language: str = Form(""),
    transcription_provider: str = Form(""),
    source_file_id: str = Form(""),
    focus: str = Form(""),
    name: str = Form(""),
    description_override: str = Form("", alias="description"),
    file: Optional[UploadFile] = File(None),
):
    if agent not in AGENTS:
        raise errors.bad_request(f"Agente precisa ser um de: {', '.join(AGENTS)}.")

    upload_name = file.filename if file is not None else ""
    upload_bytes = await file.read() if file is not None else b""

    if not _has_some_input(agent, url, topic, source_file_id, upload_name):
        raise errors.bad_request("Informe um arquivo, uma URL ou um tópico.")

    file_type, build_prompt = AGENTS[agent]
    system_prompt = build_prompt()

    def job(emit: Callable[[str, Any], None]) -> None:
        # Resolvido AQUI DENTRO (não antes do StreamingResponse) — a transcrição/leitura pode
        # levar minutos, e isso já roda numa thread própria (ver sse.stream). Resolver antes
        # bloqueava a resposta inteira até terminar, sem o front nunca ver um único byte.
        content, resolved_title, resolved_description = _resolve_stream_input(
            agent=agent,
            url=url,
            topic=topic,
            prompt=prompt,
            language=language,
            transcription_provider=transcription_provider,
            source_file_id=source_file_id,
            focus=focus,
            upload_name=upload_name,
            upload_bytes=upload_bytes,
        )
        title = name.strip() or resolved_title
        description = description_override.strip() or resolved_description

        with Session(engine) as session:
            temp_file = service.start_temp_file(session, title, file_type, description)
            temp_file_id = temp_file.id

        emit("temp_file_id_ready", {"temp_file_id": temp_file_id})
        if title:
            emit("original_title", title)
        if description:
            emit("original_description", description)

        try:
            markdown = pipeline.generate_content(content, system_prompt, emit)
        except Exception:
            service.finish_temp_file(temp_file_id, "", TempFileStatus.error)
            raise

        service.finish_temp_file(temp_file_id, markdown, TempFileStatus.complete)
        emit("temp_file_saved", {"temp_file_id": temp_file_id})

    return StreamingResponse(sse.stream(job), headers=sse.SSE_HEADERS)


@router.post("/explanations")
def generate_explanation_from_selection(data: ExplanationRequest):
    excerpt = data.excerpt.strip()
    if not excerpt:
        raise errors.bad_request("Parâmetro 'excerpt' é obrigatório.")
    if not data.file_id:
        raise errors.bad_request("Parâmetro 'file_id' é obrigatório.")

    with Session(engine) as session:
        content, source_name = service.build_selection_input(
            session, data.file_id, excerpt, data.prompt or ""
        )

    title = _selection_title(excerpt)
    parent_file_id = data.file_id

    def job(emit: Callable[[str, Any], None]) -> None:
        with Session(engine) as session:
            temp_file = service.start_temp_file(
                session,
                title,
                FileType.explanation,
                description=source_name,
                parent_file_id=parent_file_id,
                source_excerpt=excerpt,
            )
            temp_file_id = temp_file.id

        emit("temp_file_id_ready", {"temp_file_id": temp_file_id})
        emit("original_title", title)

        try:
            markdown = pipeline.generate_content(content, prompts.explanation_prompt(), emit)
        except Exception:
            service.finish_temp_file(temp_file_id, "", TempFileStatus.error)
            raise

        service.finish_temp_file(temp_file_id, markdown, TempFileStatus.complete)
        emit("temp_file_saved", {"temp_file_id": temp_file_id})

    return StreamingResponse(sse.stream(job), headers=sse.SSE_HEADERS)


@router.post("/questions", response_model=QuestionsResult)
def generate_questions(data: QuestionsRequest):
    markdown = data.markdown.strip()
    if not markdown:
        raise errors.bad_request("Parâmetro 'markdown' é obrigatório.")

    questions, raw = service.generate_questions(
        markdown, data.title or "Questões", data.type or "class"
    )

    if questions and data.file_id:
        service.persist_questions(data.file_id, questions)

    return QuestionsResult(questions=questions, raw=None if questions else raw)


@router.post("/reading-exams", response_model=QuestionsResult)
def generate_reading_exam(data: ReadingExamRequest):
    if not data.content.strip():
        raise errors.bad_request("Parâmetro 'content' é obrigatório.")
    if not data.title.strip():
        raise errors.bad_request("Parâmetro 'title' é obrigatório.")

    questions, raw = service.generate_reading_exam(data.content, data.title)
    return QuestionsResult(questions=questions, raw=None if questions else raw)


def _resolve_stream_input(
    agent: str,
    url: str,
    topic: str,
    prompt: str,
    language: str,
    source_file_id: str,
    focus: str,
    upload_name: str,
    upload_bytes: bytes,
    transcription_provider: str = "",
) -> tuple[str, str, str]:
    if agent == "explanation" and topic.strip():
        title = topic.strip()[:60]
        return topic.strip(), title, topic.strip()

    if agent == "explanation" and source_file_id:
        with Session(engine) as session:
            from app.files.service import get_file

            source = get_file(session, source_file_id)
        content = f"# {source.name}\n\n{source.content}"
        if focus:
            content = f"{content}\n\n{focus}"
        return content, source.name, source.name

    if url.strip():
        title, content = fetch_content(url.strip(), language or "en", transcription_provider)
        return f"# {title}\n\n{content}", title, url.strip()

    if upload_name:
        content = service.read_upload(
            upload_name,
            upload_bytes,
            language,
            prompt,
            transcription_provider=transcription_provider,
        )
        return content, upload_name, upload_name

    raise errors.bad_request("Informe um arquivo, uma URL ou um tópico.")


def _selection_title(excerpt: str) -> str:
    condensed = " ".join(excerpt.split())
    return condensed[:60] if len(condensed) <= 60 else f"{condensed[:57]}..."
