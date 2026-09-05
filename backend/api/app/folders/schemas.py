from typing import Any, Optional

from pydantic import BaseModel


class FolderCreate(BaseModel):
    name: str
    folder_id: Optional[str] = None


class FolderUpdate(BaseModel):
    name: Optional[str] = None
    folder_id: Optional[str] = None


class FolderMove(BaseModel):
    folder_id: Optional[str] = None


class FolderRead(BaseModel):
    id: str
    name: str
    folder_id: Optional[str] = None


class TreeNode(BaseModel):
    kind: str
    id: str
    name: str
    folder_id: Optional[str] = None
    type: Optional[str] = None
    content_type: Optional[str] = None
    description: Optional[str] = None
    questions_count: int = 0
    children: list[Any] = []
