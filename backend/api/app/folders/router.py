from fastapi import APIRouter, Depends
from sqlmodel import Session

from app.db import get_session
from app.folders import service
from app.folders.schemas import (
    FolderCreate,
    FolderMove,
    FolderRead,
    FolderUpdate,
    TreeNode,
)
from app.questions.schemas import QuestionRead

router = APIRouter(prefix="/folders", tags=["folders"])


@router.get("", response_model=list[FolderRead])
def list_folders(session: Session = Depends(get_session)):
    return service.list_folders(session)


@router.get("/tree", response_model=list[TreeNode])
def folder_tree(session: Session = Depends(get_session)):
    return service.build_tree(session)


@router.post("", response_model=FolderRead, status_code=201)
def create_folder(data: FolderCreate, session: Session = Depends(get_session)):
    return service.create_folder(session, data)


@router.get("/{folder_id}", response_model=FolderRead)
def get_folder(folder_id: str, session: Session = Depends(get_session)):
    return service.get_folder(session, folder_id)


@router.patch("/{folder_id}", response_model=FolderRead)
def update_folder(folder_id: str, data: FolderUpdate, session: Session = Depends(get_session)):
    return service.update_folder(session, folder_id, data)


@router.patch("/{folder_id}/move", response_model=FolderRead)
def move_folder(folder_id: str, data: FolderMove, session: Session = Depends(get_session)):
    return service.move_folder(session, folder_id, data.folder_id)


@router.delete("/{folder_id}", status_code=204)
def delete_folder(folder_id: str, session: Session = Depends(get_session)):
    service.delete_folder(session, folder_id)


@router.get("/{folder_id}/questions", response_model=list[QuestionRead])
def folder_questions(folder_id: str, session: Session = Depends(get_session)):
    return service.folder_questions(session, folder_id)
