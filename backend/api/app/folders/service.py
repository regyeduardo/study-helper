from typing import Optional

from sqlmodel import Session, func, select

from app import errors
from app.files.models import File
from app.folders.models import Folder
from app.folders.schemas import FolderCreate, FolderUpdate, TreeNode
from app.questions.models import Question


def list_folders(session: Session) -> list[Folder]:
    return list(session.exec(select(Folder)).all())


def get_folder(session: Session, folder_id: str) -> Folder:
    folder = session.get(Folder, folder_id)
    if folder is None:
        raise errors.not_found("Pasta não encontrada.")
    return folder


def create_folder(session: Session, data: FolderCreate) -> Folder:
    if data.folder_id is not None:
        get_folder(session, data.folder_id)
    folder = Folder(name=data.name, folder_id=data.folder_id)
    session.add(folder)
    session.commit()
    session.refresh(folder)
    return folder


def update_folder(session: Session, folder_id: str, data: FolderUpdate) -> Folder:
    folder = get_folder(session, folder_id)
    payload = data.model_dump(exclude_unset=True)
    for key, value in payload.items():
        setattr(folder, key, value)
    session.add(folder)
    session.commit()
    session.refresh(folder)
    return folder


def move_folder(session: Session, folder_id: str, target_id: Optional[str]) -> Folder:
    folder = get_folder(session, folder_id)
    if target_id is not None:
        if target_id == folder_id or _is_descendant(session, target_id, folder_id):
            raise errors.bad_request("Não é possível mover uma pasta para dentro dela mesma.")
        get_folder(session, target_id)
    folder.folder_id = target_id
    session.add(folder)
    session.commit()
    session.refresh(folder)
    return folder


def delete_folder(session: Session, folder_id: str) -> None:
    get_folder(session, folder_id)
    _delete_recursive(session, folder_id)
    session.commit()


def folder_questions(session: Session, folder_id: str) -> list[Question]:
    get_folder(session, folder_id)
    file_ids = _descendant_file_ids(session, folder_id)
    if not file_ids:
        return []
    statement = select(Question).where(Question.file_id.in_(file_ids))
    return list(session.exec(statement).all())


def build_tree(session: Session, parent_id: Optional[str] = None) -> list[TreeNode]:
    nodes: list[TreeNode] = []

    folders = session.exec(select(Folder).where(Folder.folder_id == parent_id)).all()
    for folder in folders:
        nodes.append(
            TreeNode(
                kind="folder",
                id=folder.id,
                name=folder.name,
                folder_id=folder.folder_id,
                children=build_tree(session, folder.id),
            )
        )

    files = session.exec(select(File).where(File.folder_id == parent_id)).all()
    for file in files:
        nodes.append(
            TreeNode(
                kind="file",
                id=file.id,
                name=file.name,
                folder_id=file.folder_id,
                type=file.type.value if file.type else None,
                content_type=file.content_type,
                description=file.description,
                questions_count=count_questions(session, file.id),
            )
        )

    return nodes


def count_questions(session: Session, file_id: str) -> int:
    statement = select(func.count()).select_from(Question).where(Question.file_id == file_id)
    return int(session.exec(statement).one())


def _child_folder_ids(session: Session, folder_id: str) -> list[str]:
    statement = select(Folder.id).where(Folder.folder_id == folder_id)
    return list(session.exec(statement).all())


def _descendant_file_ids(session: Session, folder_id: str) -> list[str]:
    file_ids = list(session.exec(select(File.id).where(File.folder_id == folder_id)).all())
    for child_id in _child_folder_ids(session, folder_id):
        file_ids.extend(_descendant_file_ids(session, child_id))
    return file_ids


def _is_descendant(session: Session, candidate_id: str, ancestor_id: str) -> bool:
    current = session.get(Folder, candidate_id)
    while current is not None and current.folder_id is not None:
        if current.folder_id == ancestor_id:
            return True
        current = session.get(Folder, current.folder_id)
    return False


def _delete_recursive(session: Session, folder_id: str) -> None:
    for file in session.exec(select(File).where(File.folder_id == folder_id)).all():
        for question in session.exec(select(Question).where(Question.file_id == file.id)).all():
            session.delete(question)
        session.delete(file)

    for child_id in _child_folder_ids(session, folder_id):
        _delete_recursive(session, child_id)

    folder = session.get(Folder, folder_id)
    if folder is not None:
        session.delete(folder)
