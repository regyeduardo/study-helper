import io
import zipfile


def test_create_get_and_update_file(client, folder):
    created = client.post(
        "/api/v1/files",
        json={"name": "Aula 1", "content": "conteúdo", "folder_id": folder["id"], "type": "class"},
    )
    assert created.status_code == 201
    file_id = created.json()["id"]

    fetched = client.get(f"/api/v1/files/{file_id}")
    assert fetched.json()["name"] == "Aula 1"
    assert fetched.json()["questions_count"] == 0

    updated = client.patch(f"/api/v1/files/{file_id}", json={"name": "Aula renomeada"})
    assert updated.json()["name"] == "Aula renomeada"


def test_move_and_delete_file(client, file):
    other = client.post("/api/v1/folders", json={"name": "Outra"}).json()

    moved = client.patch(f"/api/v1/files/{file['id']}/move", json={"folder_id": other["id"]})
    assert moved.json()["folder_id"] == other["id"]

    assert client.delete(f"/api/v1/files/{file['id']}").status_code == 204
    assert client.get(f"/api/v1/files/{file['id']}").status_code == 404


def test_bulk_operations(client, folder):
    ids = [
        client.post("/api/v1/files", json={"name": f"Arquivo {index}", "content": "x"}).json()["id"]
        for index in range(3)
    ]

    assert client.post("/api/v1/files/bulk-move", json={"ids": ids, "folder_id": folder["id"]}).status_code == 204
    assert all(client.get(f"/api/v1/files/{item}").json()["folder_id"] == folder["id"] for item in ids)

    export = client.post("/api/v1/files/bulk-export", json={"ids": ids})
    assert export.status_code == 200
    with zipfile.ZipFile(io.BytesIO(export.content)) as archive:
        assert len(archive.namelist()) == 3

    assert client.post("/api/v1/files/bulk-delete", json={"ids": ids}).status_code == 204
    assert client.get("/api/v1/files").json() == []


def test_lineage_returns_chain_from_root(client, file):
    child = client.post(
        "/api/v1/files",
        json={
            "name": "Explicação do trecho",
            "content": "detalhe",
            "type": "explanation",
            "parent_file_id": file["id"],
            "source_excerpt": "trecho selecionado",
        },
    ).json()

    grandchild = client.post(
        "/api/v1/files",
        json={
            "name": "Explicação da explicação",
            "content": "mais detalhe",
            "type": "explanation",
            "parent_file_id": child["id"],
            "source_excerpt": "outro trecho",
        },
    ).json()

    lineage = client.get(f"/api/v1/files/{grandchild['id']}/lineage").json()
    assert [step["name"] for step in lineage] == [file["name"], child["name"]]
    assert lineage[-1]["source_excerpt"] == "outro trecho"


def test_lineage_is_empty_for_root_file(client, file):
    assert client.get(f"/api/v1/files/{file['id']}/lineage").json() == []


def test_deleting_parent_keeps_child(client, file):
    child = client.post(
        "/api/v1/files",
        json={"name": "Filho", "content": "x", "parent_file_id": file["id"]},
    ).json()

    client.delete(f"/api/v1/files/{file['id']}")
    assert client.get(f"/api/v1/files/{child['id']}").json()["parent_file_id"] is None
