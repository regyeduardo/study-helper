from fastapi import APIRouter, Depends, Response
from sqlmodel import Session

from app.db import get_session
from app.files import service
from app.files.schemas import (
    BulkIds,
    BulkMove,
    FileCreate,
    FileMove,
    FileRead,
    FileSummary,
    FileUpdate,
    LineageStep,
)

router = APIRouter(prefix="/files", tags=["files"])


@router.get("", response_model=list[FileSummary])
def list_files(session: Session = Depends(get_session)):
    return service.with_counts(session, service.list_files(session))


@router.post("", response_model=FileRead, status_code=201)
def create_file(data: FileCreate, session: Session = Depends(get_session)):
    return service.create_file(session, data)


@router.post("/bulk-delete", status_code=204)
def bulk_delete(data: BulkIds, session: Session = Depends(get_session)):
    service.bulk_delete(session, data.ids)


@router.post("/bulk-move", status_code=204)
def bulk_move(data: BulkMove, session: Session = Depends(get_session)):
    service.bulk_move(session, data.ids, data.folder_id)


@router.post("/bulk-export")
def bulk_export(data: BulkIds, session: Session = Depends(get_session)):
    content = service.export_zip(session, data.ids)
    return Response(
        content=content,
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="study-helper.zip"'},
    )


@router.get("/by-hash/{file_hash}", response_model=FileRead)
def get_file_by_hash(file_hash: str, session: Session = Depends(get_session)):
    return service.get_file_by_hash(session, file_hash)


@router.get("/{file_id}", response_model=FileRead)
def get_file(file_id: str, session: Session = Depends(get_session)):
    file = service.get_file(session, file_id)
    return service.with_counts(session, [file])[0]


@router.patch("/{file_id}", response_model=FileRead)
def update_file(file_id: str, data: FileUpdate, session: Session = Depends(get_session)):
    return service.update_file(session, file_id, data)


@router.patch("/{file_id}/move", response_model=FileRead)
def move_file(file_id: str, data: FileMove, session: Session = Depends(get_session)):
    return service.move_file(session, file_id, data.folder_id)


@router.delete("/{file_id}", status_code=204)
def delete_file(file_id: str, session: Session = Depends(get_session)):
    service.delete_file(session, file_id)


@router.get("/{file_id}/lineage", response_model=list[LineageStep])
def file_lineage(file_id: str, session: Session = Depends(get_session)):
    return service.lineage(session, file_id)
