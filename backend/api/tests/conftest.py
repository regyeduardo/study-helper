import os
import sys
from pathlib import Path

os.environ.setdefault("DATABASE_URL", "sqlite://")
# Force, don't just default — a dev .env with TEST_MODE=false (needed for real usage) must
# not leak into the test run and make tests hit real external services.
os.environ["TEST_MODE"] = "true"

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlmodel import SQLModel  # noqa: E402

from app.db import engine  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture(autouse=True)
def database():
    SQLModel.metadata.drop_all(engine)
    SQLModel.metadata.create_all(engine)
    yield
    SQLModel.metadata.drop_all(engine)


@pytest.fixture
def client():
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def folder(client):
    return client.post("/api/v1/folders", json={"name": "Estudos"}).json()


@pytest.fixture
def file(client, folder):
    payload = {
        "name": "Aula de Python",
        "content": "# Aula\n\nConteúdo da aula.",
        "folder_id": folder["id"],
        "type": "class",
    }
    return client.post("/api/v1/files", json=payload).json()
