def parse_events(text: str) -> list[tuple[str, str]]:
    events = []
    for block in text.split("\n\n"):
        lines = [line for line in block.split("\n") if line]
        if len(lines) < 2:
            continue
        events.append((lines[0].removeprefix("event: "), lines[1].removeprefix("data: ")))
    return events


LESSON_CONTENT = (
    "Índice em banco de dados é uma estrutura de dados auxiliar que acelera buscas numa "
    "tabela, funcionando como o índice remissivo de um livro: em vez de percorrer cada "
    "linha (table scan), o banco consulta uma estrutura ordenada (geralmente uma B-tree) "
    "que aponta direto para a linha desejada. O custo é escrita mais lenta (todo insert, "
    "update ou delete também atualiza os índices) e espaço em disco extra. Índices "
    "compostos, cobrindo múltiplas colunas, só ajudam consultas que usam o prefixo "
    "esquerdo das colunas indexadas — um índice em (a, b) acelera filtros por 'a' ou por "
    "'a e b', mas não um filtro só por 'b'."
)


def test_lesson_generation_creates_complete_temp_file(client):
    response = client.post(
        "/api/v1/generations/lessons", json={"content": LESSON_CONTENT, "title": "Aula", "size": "short"}
    )
    assert response.status_code == 200

    body = response.json()
    assert body["markdown"].startswith("#")
    temp_file = client.get(f"/api/v1/temp-files/{body['temp_file_id']}").json()
    assert temp_file["status"] == "complete"
    assert temp_file["type"] == "class"


def test_lesson_generation_requires_content(client):
    assert client.post("/api/v1/generations/lessons", json={"content": "   "}).status_code == 400


def test_stream_emits_pipeline_events(client):
    response = client.post(
        "/api/v1/generations/stream",
        data={"agent": "lesson", "topic": "", "size": "medium"},
        files={"file": ("aula.txt", b"conteudo de teste", "text/plain")},
    )
    assert response.status_code == 200

    names = [name for name, _ in parse_events(response.text)]
    assert names[0] == "temp_file_id_ready"
    assert "phase1_complete" in names
    assert "lesson_complete" in names
    assert names[-1] == "temp_file_saved"


def test_stream_requires_some_input(client):
    response = client.post("/api/v1/generations/stream", data={"agent": "lesson"})
    assert response.status_code == 400


def test_stream_rejects_unknown_agent(client):
    response = client.post("/api/v1/generations/stream", data={"agent": "resumo"})
    assert response.status_code == 400


def test_explanation_from_selection_records_lineage(client, file):
    response = client.post(
        "/api/v1/generations/explanations",
        json={"file_id": file["id"], "excerpt": "trecho que quero entender"},
    )
    assert response.status_code == 200

    events = dict(parse_events(response.text))
    assert "temp_file_saved" in events

    temp_files = client.get("/api/v1/temp-files").json()
    assert temp_files[0]["parent_file_id"] == file["id"]
    assert temp_files[0]["source_excerpt"] == "trecho que quero entender"
    assert temp_files[0]["type"] == "explanation"


def test_explanation_requires_excerpt_and_file(client, file):
    assert client.post(
        "/api/v1/generations/explanations", json={"file_id": file["id"], "excerpt": " "}
    ).status_code == 400
    assert client.post(
        "/api/v1/generations/explanations", json={"excerpt": "algo"}
    ).status_code == 400


def test_explanation_chain_can_repeat(client, file):
    client.post(
        "/api/v1/generations/explanations",
        json={"file_id": file["id"], "excerpt": "primeiro trecho"},
    )
    temp_id = client.get("/api/v1/temp-files").json()[0]["id"]
    saved = client.post(f"/api/v1/temp-files/{temp_id}/restore", json={}).json()

    client.post(
        "/api/v1/generations/explanations",
        json={"file_id": saved["file_id"], "excerpt": "segundo trecho"},
    )
    second_temp = client.get("/api/v1/temp-files").json()[0]
    assert second_temp["parent_file_id"] == saved["file_id"]


def test_questions_generation_persists_when_file_given(client, file):
    response = client.post(
        "/api/v1/generations/questions",
        json={"markdown": f"# Aula\n\n{LESSON_CONTENT}", "title": "Aula", "file_id": file["id"]},
    )
    assert response.status_code == 200
    assert len(response.json()["questions"]) > 0
    assert len(client.get(f"/api/v1/files/{file['id']}/questions").json()) > 0


def test_questions_generation_requires_markdown(client):
    assert client.post("/api/v1/generations/questions", json={"markdown": " "}).status_code == 400


def test_reading_exam_generation(client):
    response = client.post(
        "/api/v1/generations/reading-exams",
        json={"content": "texto do artigo", "title": "Artigo"},
    )
    assert response.status_code == 200
    assert len(response.json()["questions"]) > 0


def test_regeneration_returns_markdown(client):
    response = client.post(
        "/api/v1/generations/regenerations", json={"content": "conteúdo antigo", "title": "Aula"}
    )
    assert response.status_code == 200
    assert response.json()["markdown"].startswith("#")


def test_generated_markdown_has_no_external_links(client):
    markdown = client.post(
        "/api/v1/generations/lessons", json={"content": "texto", "title": "Aula"}
    ).json()["markdown"]

    assert "http://" not in markdown.replace("```", "")
    assert "https://" not in markdown.replace("```", "")


def test_subtitle_upload_is_treated_as_text(client, monkeypatch):
    from app.transcription import service as transcription

    def fail(*args, **kwargs):
        raise AssertionError("legenda não pode ir para transcrição")

    monkeypatch.setattr(transcription, "transcribe", fail)

    srt = b"1\n00:00:01,000 --> 00:00:04,000\nBem-vindo a aula de redes.\n"
    response = client.post(
        "/api/v1/generations/stream",
        data={"agent": "lesson", "size": "short"},
        files={"file": ("aula.srt", srt, "application/x-subrip")},
    )

    assert response.status_code == 200
    assert "lesson_complete" in response.text


def test_text_upload_without_extension_is_not_transcribed(client, monkeypatch):
    from app.transcription import service as transcription

    monkeypatch.setattr(
        transcription, "transcribe", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError())
    )

    response = client.post(
        "/api/v1/generations/stream",
        data={"agent": "lesson"},
        files={"file": ("anotacoes", b"texto puro sem extensao", "application/octet-stream")},
    )

    assert response.status_code == 200
