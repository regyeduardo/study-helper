from datetime import datetime
from typing import Optional

from pydantic import BaseModel

from app.shared.enums import FileType, TempFileStatus


class TempFileCreate(BaseModel):
    name: str
    content: str = ""
    content_type: Optional[str] = "markdown"
    type: Optional[FileType] = None
    description: Optional[str] = None
    status: TempFileStatus = TempFileStatus.complete
    parent_file_id: Optional[str] = None
    source_excerpt: Optional[str] = None


class TempFileUpdate(BaseModel):
    name: Optional[str] = None
    content: Optional[str] = None
    status: Optional[TempFileStatus] = None
    description: Optional[str] = None


class TempFileRead(BaseModel):
    id: str
    name: str
    content: str
    content_type: Optional[str] = None
    type: Optional[FileType] = None
    description: Optional[str] = None
    status: TempFileStatus
    parent_file_id: Optional[str] = None
    source_excerpt: Optional[str] = None
    created_at: datetime


class TempFileLookup(BaseModel):
    name: Optional[str] = None
    content_type: Optional[str] = None
    description: Optional[str] = None


class TempFileRestore(BaseModel):
    name: Optional[str] = None
    folder_id: Optional[str] = None
    description: Optional[str] = None


class RestoreResult(BaseModel):
    file_id: str
    file_name: str
