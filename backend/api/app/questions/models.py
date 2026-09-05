from datetime import datetime
from typing import Optional

from sqlmodel import Field, SQLModel

from app.shared.enums import RightAlternative
from app.shared.ids import new_id, utc_now


class Question(SQLModel, table=True):
    __tablename__ = "questions"

    id: str = Field(default_factory=new_id, primary_key=True)
    statement: str
    alternative_a: str
    alternative_b: str
    alternative_c: str
    alternative_d: str
    alternative_e: str
    right_alternative: RightAlternative
    explanation: Optional[str] = None
    diagram: Optional[str] = None
    file_id: str = Field(foreign_key="files.id", index=True)
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)
