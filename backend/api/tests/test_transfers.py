import io
import json
import zipfile


def make_zip(markdown: str, questions: list | None = None) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("aula.md", markdown)
        if questions is not None:
            archive.writestr("aula-questions.json", json.dumps(questions))
    return buffer.getvalue()


def test_preview_markdown_with_frontmatter(client):
    content = b"---\ntype: explanation\n---\n\n# Titulo\n\ncorpo"
    response = client.post("/api/v1/imports/preview", files={"file": ("nota.md", content, "text/markdown")})

    assert response.status_code == 200
    assert response.json()["type"] == "explanation"
    assert response.json()["markdown"].startswith("# Titulo")


def test_preview_zip_with_questions(client):
    payload = make_zip("---\ntype: class\n---\n\n# Aula", [{"id": 1}])
    response = client.post("/api/v1/imports/preview", files={"file": ("aula.zip", payload, "application/zip")})

    body = response.json()
    assert body["markdown"] == "# Aula"
    assert body["type"] == "class"
    assert body["questions"] == [{"id": 1}]


def test_preview_rejects_unsupported_format(client):
    response = client.post("/api/v1/imports/preview", files={"file": ("a.docx", b"x", "application/msword")})
    assert response.status_code == 400


def test_import_creates_file_in_folder(client, folder):
    content = b"---\ntype: reading\n---\n\n# Artigo\n\ntexto"
    response = client.post(
        "/api/v1/imports/files",
        files={"file": ("artigo.md", content, "text/markdown")},
        data={"folder_id": folder["id"]},
    )

    assert response.status_code == 201
    saved = client.get(f"/api/v1/files/{response.json()['file_id']}").json()
    assert saved["folder_id"] == folder["id"]
    assert saved["type"] == "reading"


def test_export_zip_contains_markdown_and_questions(client):
    response = client.post(
        "/api/v1/exports/zip",
        json={
            "markdown": "# Aula",
            "questions": {"questions": [{"id": 1}]},
            "filename": "minha-aula",
            "type": "class",
        },
    )

    assert response.status_code == 200
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        assert sorted(archive.namelist()) == ["minha-aula-questions.json", "minha-aula.md"]
        assert archive.read("minha-aula.md").decode().startswith("---\ntype: class\n---")


def test_export_zip_without_questions(client):
    response = client.post("/api/v1/exports/zip", json={"markdown": "# Aula"})
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        assert archive.namelist() == ["conteudo.md"]
