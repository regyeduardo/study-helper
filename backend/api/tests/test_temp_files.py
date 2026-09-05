def create_temp(client, **overrides):
    payload = {
        "name": "2026-08-03 10:00:00 - Aula",
        "content": "# Aula\n\ntexto",
        "type": "class",
        "status": "complete",
    }
    payload.update(overrides)
    return client.post("/api/v1/temp-files", json=payload).json()


def test_create_and_list(client):
    created = create_temp(client)
    assert created["status"] == "complete"
    assert len(client.get("/api/v1/temp-files").json()) == 1


def test_active_returns_generating_one(client):
    assert client.get("/api/v1/temp-files/active").status_code == 204

    generating = create_temp(client, status="generating")
    active = client.get("/api/v1/temp-files/active")
    assert active.status_code == 200
    assert active.json()["id"] == generating["id"]


def test_patch_updates_content_and_status(client):
    temp = create_temp(client, status="generating", content="")
    updated = client.patch(
        f"/api/v1/temp-files/{temp['id']}", json={"content": "pronto", "status": "complete"}
    ).json()

    assert updated["content"] == "pronto"
    assert updated["status"] == "complete"
    assert client.get("/api/v1/temp-files/active").status_code == 204


def test_lookup_filters_by_name(client):
    create_temp(client, name="Aula de Python")
    create_temp(client, name="Aula de Go")

    found = client.post("/api/v1/temp-files/lookup", json={"name": "Python"}).json()
    assert len(found) == 1


def test_restore_creates_file_and_removes_temp(client, folder):
    temp = create_temp(client)
    restored = client.post(
        f"/api/v1/temp-files/{temp['id']}/restore",
        json={"name": "Aula salva", "folder_id": folder["id"], "description": "de teste"},
    )

    assert restored.status_code == 201
    file_id = restored.json()["file_id"]

    saved = client.get(f"/api/v1/files/{file_id}").json()
    assert saved["name"] == "Aula salva"
    assert saved["folder_id"] == folder["id"]
    assert client.get(f"/api/v1/temp-files/{temp['id']}").status_code == 404


def test_restore_keeps_lineage(client, file):
    temp = create_temp(
        client,
        type="explanation",
        parent_file_id=file["id"],
        source_excerpt="trecho selecionado",
    )
    file_id = client.post(f"/api/v1/temp-files/{temp['id']}/restore", json={}).json()["file_id"]

    saved = client.get(f"/api/v1/files/{file_id}").json()
    assert saved["parent_file_id"] == file["id"]
    assert saved["source_excerpt"] == "trecho selecionado"
    assert [step["name"] for step in client.get(f"/api/v1/files/{file_id}/lineage").json()] == [file["name"]]


def test_restore_blocked_while_generating(client):
    temp = create_temp(client, status="generating")
    assert client.post(f"/api/v1/temp-files/{temp['id']}/restore", json={}).status_code == 409


def test_delete_temp_file(client):
    temp = create_temp(client)
    assert client.delete(f"/api/v1/temp-files/{temp['id']}").status_code == 204
    assert client.get("/api/v1/temp-files").json() == []
