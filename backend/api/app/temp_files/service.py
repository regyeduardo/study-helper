from typing import Optional

from sqlmodel import Session, col, select

from app import errors
from app.files.models import File
from app.folders.service import get_folder
from app.shared.enums import TempFileStatus
from app.shared.ids import utc_now
from app.temp_files.models import TempFile
from app.temp_files.schemas import (
    TempFileCreate,
    TempFileLookup,
    TempFileRestore,
    TempFileUpdate,
)


def list_temp_files(session: Session) -> list[TempFile]:
    statement = select(TempFile).order_by(col(TempFile.created_at).desc())
    return list(session.exec(statement).all())


def get_temp_file(session: Session, temp_file_id: str) -> TempFile:
    temp_file = session.get(TempFile, temp_file_id)
    if temp_file is None:
        raise errors.not_found("Arquivo temporário não encontrado.")
    return temp_file


def active_temp_file(session: Session) -> Optional[TempFile]:
    statement = (
        select(TempFile)
        .where(TempFile.status == TempFileStatus.generating)
        .order_by(col(TempFile.created_at).desc())
    )
    return session.exec(statement).first()


def create_temp_file(session: Session, data: TempFileCreate) -> TempFile:
    if data.parent_file_id is not None and session.get(File, data.parent_file_id) is None:
        raise errors.not_found("Arquivo de origem não encontrado.")
    temp_file = TempFile(**data.model_dump())
    session.add(temp_file)
    session.commit()
    session.refresh(temp_file)
    return temp_file


def update_temp_file(session: Session, temp_file_id: str, data: TempFileUpdate) -> TempFile:
    temp_file = get_temp_file(session, temp_file_id)
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(temp_file, key, value)
    session.add(temp_file)
    session.commit()
    session.refresh(temp_file)
    return temp_file


def delete_temp_file(session: Session, temp_file_id: str) -> None:
    temp_file = get_temp_file(session, temp_file_id)
    session.delete(temp_file)
    session.commit()


def lookup(session: Session, data: TempFileLookup) -> list[TempFile]:
    statement = select(TempFile)
    if data.name:
        statement = statement.where(col(TempFile.name).contains(data.name))
    if data.content_type:
        statement = statement.where(TempFile.content_type == data.content_type)
    if data.description:
        statement = statement.where(col(TempFile.description).contains(data.description))
    statement = statement.order_by(col(TempFile.created_at).desc())
    return list(session.exec(statement).all())


def restore(session: Session, temp_file_id: str, data: TempFileRestore) -> File:
    temp_file = get_temp_file(session, temp_file_id)
    if temp_file.status == TempFileStatus.generating:
        raise errors.conflict("Geração ainda em andamento.")
    if data.folder_id is not None:
        get_folder(session, data.folder_id)

    file = File(
        name=data.name or temp_file.name,
        content=temp_file.content,
        content_type=temp_file.content_type or "markdown",
        folder_id=data.folder_id,
        type=temp_file.type,
        description=data.description if data.description is not None else temp_file.description,
        parent_file_id=temp_file.parent_file_id,
        source_excerpt=temp_file.source_excerpt,
        created_at=utc_now(),
        updated_at=utc_now(),
    )
    session.add(file)
    session.delete(temp_file)
    session.commit()
    session.refresh(file)
    return file
