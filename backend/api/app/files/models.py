from datetime import datetime
from typing import Optional

from sqlmodel import Field, SQLModel

from app.shared.enums import FileType
from app.shared.ids import new_hash, new_id, utc_now


class File(SQLModel, table=True):
    __tablename__ = "files"

    id: str = Field(default_factory=new_id, primary_key=True)
    hash: str = Field(default_factory=new_hash, index=True, unique=True)
    name: str
    content: str = ""
    content_type: Optional[str] = None
    folder_id: Optional[str] = Field(default=None, foreign_key="folders.id", index=True)
    type: Optional[FileType] = None
    description: Optional[str] = None
    parent_file_id: Optional[str] = Field(default=None, foreign_key="files.id", index=True)
    source_excerpt: Optional[str] = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)
