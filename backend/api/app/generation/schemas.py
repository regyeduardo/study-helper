from typing import Optional

from app.shared.enums import FileType
from pydantic import BaseModel



class LessonRequest(BaseModel):
    content: str
    title: Optional[str] = None


class LessonResult(BaseModel):
    markdown: str
    temp_file_id: Optional[str] = None


class RegenerationRequest(BaseModel):
    content: str
    title: Optional[str] = None
    type: Optional[FileType] = None


class MarkdownResult(BaseModel):
    markdown: str


class ExplanationRequest(BaseModel):
    file_id: Optional[str] = None
    temp_file_id: Optional[str] = None
    excerpt: str
    prompt: Optional[str] = None


class QuestionsRequest(BaseModel):
    markdown: str
    title: Optional[str] = None
    file_id: Optional[str] = None
    type: Optional[str] = None


class ReadingExamRequest(BaseModel):
    content: str
    title: str


class QuestionsResult(BaseModel):
    questions: list[dict]
    raw: Optional[str] = None
