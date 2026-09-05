from datetime import datetime
from typing import Optional

from pydantic import BaseModel

from app.shared.enums import FileType


class FileCreate(BaseModel):
    name: str
    content: str = ""
    content_type: Optional[str] = "markdown"
    folder_id: Optional[str] = None
    type: Optional[FileType] = None
    description: Optional[str] = None
    parent_file_id: Optional[str] = None
    source_excerpt: Optional[str] = None


class FileUpdate(BaseModel):
    name: Optional[str] = None
    content: Optional[str] = None
    content_type: Optional[str] = None
    folder_id: Optional[str] = None
    type: Optional[FileType] = None
    description: Optional[str] = None


class FileMove(BaseModel):
    folder_id: Optional[str] = None


class FileRead(BaseModel):
    id: str
    hash: str = ""
    name: str
    content: str
    content_type: Optional[str] = None
    folder_id: Optional[str] = None
    type: Optional[FileType] = None
    description: Optional[str] = None
    parent_file_id: Optional[str] = None
    source_excerpt: Optional[str] = None
    questions_count: int = 0
    created_at: datetime
    updated_at: datetime


class FileSummary(BaseModel):
    id: str
    hash: str = ""
    name: str
    content_type: Optional[str] = None
    folder_id: Optional[str] = None
    type: Optional[FileType] = None
    description: Optional[str] = None
    parent_file_id: Optional[str] = None
    questions_count: int = 0
    created_at: datetime
    updated_at: datetime


class LineageStep(BaseModel):
    id: str
    name: str
    type: Optional[FileType] = None
    source_excerpt: Optional[str] = None


class BulkIds(BaseModel):
    ids: list[str]


class BulkMove(BaseModel):
    ids: list[str]
    folder_id: Optional[str] = None
