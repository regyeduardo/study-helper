import io
import zipfile
from typing import Optional

from sqlmodel import Session, select

from app import errors
from app.files.models import File
from app.files.schemas import FileCreate, FileUpdate, LineageStep
from app.folders.service import count_questions, get_folder
from app.questions.service import delete_for_file
from app.shared.frontmatter import add_frontmatter
from app.shared.ids import utc_now

MAX_LINEAGE_DEPTH = 200


def list_files(session: Session) -> list[File]:
    return list(session.exec(select(File)).all())


def get_file(session: Session, file_id: str) -> File:
    file = session.get(File, file_id)
    if file is None:
        raise errors.not_found("Arquivo não encontrado.")
    return file


def get_file_by_hash(session: Session, file_hash: str) -> File:
    file = session.exec(select(File).where(File.hash == file_hash)).first()
    if file is None:
        raise errors.not_found("Arquivo não encontrado.")
    return file


def create_file(session: Session, data: FileCreate) -> File:
    if data.folder_id is not None:
        get_folder(session, data.folder_id)
    if data.parent_file_id is not None:
        get_file(session, data.parent_file_id)

    file = File(**data.model_dump())
    session.add(file)
    session.commit()
    session.refresh(file)
    return file


def update_file(session: Session, file_id: str, data: FileUpdate) -> File:
    file = get_file(session, file_id)
    payload = data.model_dump(exclude_unset=True)
    if payload.get("folder_id") is not None:
        get_folder(session, payload["folder_id"])
    for key, value in payload.items():
        setattr(file, key, value)
    file.updated_at = utc_now()
    session.add(file)
    session.commit()
    session.refresh(file)
    return file


def move_file(session: Session, file_id: str, folder_id: Optional[str]) -> File:
    if folder_id is not None:
        get_folder(session, folder_id)
    file = get_file(session, file_id)
    file.folder_id = folder_id
    file.updated_at = utc_now()
    session.add(file)
    session.commit()
    session.refresh(file)
    return file


def delete_file(session: Session, file_id: str) -> None:
    file = get_file(session, file_id)
    delete_for_file(session, file_id, commit=False)
    for child in session.exec(select(File).where(File.parent_file_id == file_id)).all():
        child.parent_file_id = None
        session.add(child)
    session.delete(file)
    session.commit()


def bulk_delete(session: Session, ids: list[str]) -> None:
    for file_id in ids:
        if session.get(File, file_id) is not None:
            delete_file(session, file_id)


def bulk_move(session: Session, ids: list[str], folder_id: Optional[str]) -> None:
    if folder_id is not None:
        get_folder(session, folder_id)
    for file_id in ids:
        file = session.get(File, file_id)
        if file is None:
            continue
        file.folder_id = folder_id
        file.updated_at = utc_now()
        session.add(file)
    session.commit()


def lineage(session: Session, file_id: str) -> list[LineageStep]:
    file = get_file(session, file_id)
    steps: list[LineageStep] = []
    seen = {file.id}
    current = file.parent_file_id
    child_excerpt = file.source_excerpt

    while current is not None and len(steps) < MAX_LINEAGE_DEPTH:
        parent = session.get(File, current)
        if parent is None or parent.id in seen:
            break
        seen.add(parent.id)
        steps.append(
            LineageStep(
                id=parent.id,
                name=parent.name,
                type=parent.type,
                source_excerpt=child_excerpt,
            )
        )
        child_excerpt = parent.source_excerpt
        current = parent.parent_file_id

    steps.reverse()
    return steps


def export_zip(session: Session, ids: list[str]) -> bytes:
    files = [get_file(session, file_id) for file_id in ids]
    if not files:
        raise errors.bad_request("Nenhum arquivo informado.")

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        used: set[str] = set()
        for file in files:
            base = file.name.rsplit(".", 1)[0] if file.name.endswith((".md", ".zip")) else file.name
            entry = f"{base}.md"
            counter = 2
            while entry in used:
                entry = f"{base} ({counter}).md"
                counter += 1
            used.add(entry)
            file_type = file.type.value if file.type else None
            archive.writestr(entry, add_frontmatter(file.content, file_type))
    return buffer.getvalue()


def with_counts(session: Session, files: list[File]) -> list[dict]:
    result = []
    for file in files:
        data = file.model_dump()
        data["questions_count"] = count_questions(session, file.id)
        result.append(data)
    return result
