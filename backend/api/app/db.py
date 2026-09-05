from collections.abc import Iterator
from pathlib import Path

from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app import config


def _is_memory(url: str) -> bool:
    return url.startswith("sqlite") and (":memory:" in url or url.rstrip("/") == "sqlite:")


def _engine_kwargs(url: str) -> dict:
    if not url.startswith("sqlite"):
        return {}
    kwargs: dict = {"connect_args": {"check_same_thread": False}}
    if _is_memory(url):
        kwargs["poolclass"] = StaticPool
    return kwargs


def _ensure_parent_dir(url: str) -> None:
    prefix = "sqlite:///"
    if not url.startswith(prefix) or ":memory:" in url:
        return
    path = Path(url[len(prefix) :])
    path.parent.mkdir(parents=True, exist_ok=True)


_url = config.database_url()
_ensure_parent_dir(_url)
engine = create_engine(_url, echo=False, **_engine_kwargs(_url))


def create_all() -> None:
    from app.files import models as file_models  # noqa: F401
    from app.folders import models as folder_models  # noqa: F401
    from app.questions import models as question_models  # noqa: F401
    from app.temp_files import models as temp_file_models  # noqa: F401

    SQLModel.metadata.create_all(engine)


def get_session() -> Iterator[Session]:
    with Session(engine) as session:
        yield session
