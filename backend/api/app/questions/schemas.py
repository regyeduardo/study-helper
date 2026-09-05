from datetime import datetime
from typing import Optional

from pydantic import BaseModel

from app.shared.enums import RightAlternative


class QuestionWrite(BaseModel):
    statement: str
    alternative_a: str
    alternative_b: str
    alternative_c: str
    alternative_d: str
    alternative_e: str
    right_alternative: RightAlternative
    explanation: Optional[str] = None
    diagram: Optional[str] = None


class QuestionBulkWrite(BaseModel):
    questions: list[QuestionWrite]


class QuestionRead(QuestionWrite):
    id: str
    file_id: str
    created_at: datetime
    updated_at: datetime
