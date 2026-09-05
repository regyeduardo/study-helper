from sqlmodel import Session, select

from app import errors
from app.files.models import File
from app.questions.models import Question
from app.questions.schemas import QuestionWrite
from app.temp_files.models import TempFile


def list_by_file(session: Session, file_id: str) -> list[Question]:
    statement = select(Question).where(Question.file_id == file_id).order_by(Question.created_at)
    return list(session.exec(statement).all())


def replace_for_file(session: Session, file_id: str, questions: list[QuestionWrite]) -> list[Question]:
    if session.get(TempFile, file_id) is not None:
        raise errors.bad_request("Não é possível associar questões a um arquivo temporário.")
    if session.get(File, file_id) is None:
        raise errors.not_found("Arquivo não encontrado.")

    delete_for_file(session, file_id, commit=False)

    created = [Question(file_id=file_id, **item.model_dump()) for item in questions]
    for question in created:
        session.add(question)
    session.commit()
    for question in created:
        session.refresh(question)
    return created


def delete_for_file(session: Session, file_id: str, commit: bool = True) -> None:
    for question in session.exec(select(Question).where(Question.file_id == file_id)).all():
        session.delete(question)
    if commit:
        session.commit()
