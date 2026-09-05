from fastapi import APIRouter, Depends, Response
from sqlmodel import Session

from app.db import get_session
from app.temp_files import service
from app.temp_files.schemas import (
    RestoreResult,
    TempFileCreate,
    TempFileLookup,
    TempFileRead,
    TempFileRestore,
    TempFileUpdate,
)

router = APIRouter(prefix="/temp-files", tags=["temp-files"])


@router.get("", response_model=list[TempFileRead])
def list_temp_files(session: Session = Depends(get_session)):
    return service.list_temp_files(session)


@router.post("", response_model=TempFileRead, status_code=201)
def create_temp_file(data: TempFileCreate, session: Session = Depends(get_session)):
    return service.create_temp_file(session, data)


@router.get("/active", response_model=TempFileRead, responses={204: {"description": "Sem geração ativa"}})
def active_temp_file(session: Session = Depends(get_session)):
    temp_file = service.active_temp_file(session)
    if temp_file is None:
        return Response(status_code=204)
    return temp_file


@router.post("/lookup", response_model=list[TempFileRead])
def lookup(data: TempFileLookup, session: Session = Depends(get_session)):
    return service.lookup(session, data)


@router.get("/{temp_file_id}", response_model=TempFileRead)
def get_temp_file(temp_file_id: str, session: Session = Depends(get_session)):
    return service.get_temp_file(session, temp_file_id)


@router.patch("/{temp_file_id}", response_model=TempFileRead)
def update_temp_file(
    temp_file_id: str, data: TempFileUpdate, session: Session = Depends(get_session)
):
    return service.update_temp_file(session, temp_file_id, data)


@router.delete("/{temp_file_id}", status_code=204)
def delete_temp_file(temp_file_id: str, session: Session = Depends(get_session)):
    service.delete_temp_file(session, temp_file_id)


@router.post("/{temp_file_id}/restore", response_model=RestoreResult, status_code=201)
def restore_temp_file(
    temp_file_id: str, data: TempFileRestore, session: Session = Depends(get_session)
):
    file = service.restore(session, temp_file_id, data)
    return RestoreResult(file_id=file.id, file_name=file.name)
