from datetime import datetime
from typing import Optional

from sqlmodel import Field, SQLModel

from app.shared.enums import FileType, TempFileStatus
from app.shared.ids import new_id, utc_now


class TempFile(SQLModel, table=True):
    __tablename__ = "temp_files"

    id: str = Field(default_factory=new_id, primary_key=True)
    name: str
    content: str = ""
    content_type: Optional[str] = None
    type: Optional[FileType] = None
    description: Optional[str] = None
    status: TempFileStatus = Field(default=TempFileStatus.complete)
    parent_file_id: Optional[str] = Field(default=None, foreign_key="files.id", index=True)
    source_excerpt: Optional[str] = None
    created_at: datetime = Field(default_factory=utc_now)
