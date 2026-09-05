from fastapi import APIRouter, Depends
from sqlmodel import Session

from app.db import get_session
from app.questions import service
from app.questions.schemas import QuestionBulkWrite, QuestionRead

router = APIRouter(prefix="/files/{file_id}/questions", tags=["questions"])


@router.get("", response_model=list[QuestionRead])
def list_questions(file_id: str, session: Session = Depends(get_session)):
    return service.list_by_file(session, file_id)


@router.put("", response_model=list[QuestionRead])
def replace_questions(file_id: str, data: QuestionBulkWrite, session: Session = Depends(get_session)):
    return service.replace_for_file(session, file_id, data.questions)


@router.delete("", status_code=204)
def delete_questions(file_id: str, session: Session = Depends(get_session)):
    service.delete_for_file(session, file_id)
