from typing import Optional

from sqlmodel import Field, SQLModel

from app.shared.ids import new_id


class Folder(SQLModel, table=True):
    __tablename__ = "folders"

    id: str = Field(default_factory=new_id, primary_key=True)
    name: str
    folder_id: Optional[str] = Field(default=None, foreign_key="folders.id", index=True)
