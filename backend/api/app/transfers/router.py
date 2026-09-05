from typing import Any, Optional

from fastapi import APIRouter, Depends, File, Form, Response, UploadFile
from pydantic import BaseModel
from sqlmodel import Session

from app.db import get_session
from app.files.schemas import FileCreate
from app.files.service import create_file
from app.shared.enums import FileType
from app.transfers import service

router = APIRouter(tags=["transfers"])


class ExportZipRequest(BaseModel):
    markdown: str
    questions: Optional[Any] = None
    filename: Optional[str] = None
    type: Optional[str] = None


@router.post("/imports/preview")
async def preview_import(file: UploadFile = File(...)):
    payload = await file.read()
    return service.parse_upload(file.filename or "", payload)


@router.post("/imports/files", status_code=201)
async def import_file(
    file: UploadFile = File(...),
    folder_id: str = Form(""),
    session: Session = Depends(get_session),
):
    payload = await file.read()
    parsed = service.parse_upload(file.filename or "", payload)

    file_type = parsed.get("type")
    created = create_file(
        session,
        FileCreate(
            name=file.filename or "conteudo.md",
            content=parsed["markdown"],
            content_type="markdown",
            folder_id=folder_id or None,
            type=FileType(file_type) if file_type in {item.value for item in FileType} else None,
        ),
    )

    return {**parsed, "file_id": created.id}


@router.post("/exports/zip")
def export_zip(data: ExportZipRequest):
    filename = data.filename or "conteudo"
    content = service.build_zip(data.markdown, data.questions, filename, data.type)
    return Response(
        content=content,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}.zip"'},
    )
