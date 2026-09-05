def test_create_and_list_folders(client):
    created = client.post("/api/v1/folders", json={"name": "Matemática"})
    assert created.status_code == 201
    assert created.json()["name"] == "Matemática"

    listed = client.get("/api/v1/folders")
    assert listed.status_code == 200
    assert len(listed.json()) == 1


def test_nested_folder_and_tree(client, folder, file):
    child = client.post(
        "/api/v1/folders", json={"name": "Python", "folder_id": folder["id"]}
    ).json()

    tree = client.get("/api/v1/folders/tree").json()
    assert len(tree) == 1
    assert tree[0]["kind"] == "folder"

    children = tree[0]["children"]
    kinds = sorted(node["kind"] for node in children)
    assert kinds == ["file", "folder"]
    assert any(node["id"] == child["id"] for node in children)
    assert any(node["id"] == file["id"] for node in children)


def test_update_and_move_folder(client, folder):
    target = client.post("/api/v1/folders", json={"name": "Arquivo morto"}).json()

    renamed = client.patch(f"/api/v1/folders/{folder['id']}", json={"name": "Novo nome"})
    assert renamed.json()["name"] == "Novo nome"

    moved = client.patch(
        f"/api/v1/folders/{folder['id']}/move", json={"folder_id": target["id"]}
    )
    assert moved.json()["folder_id"] == target["id"]


def test_cannot_move_folder_into_itself(client, folder):
    response = client.patch(
        f"/api/v1/folders/{folder['id']}/move", json={"folder_id": folder["id"]}
    )
    assert response.status_code == 400


def test_delete_folder_removes_files(client, folder, file):
    response = client.delete(f"/api/v1/folders/{folder['id']}")
    assert response.status_code == 204
    assert client.get(f"/api/v1/files/{file['id']}").status_code == 404


def test_folder_questions_includes_nested_files(client, folder, file):
    questions = [
        {
            "statement": "Qual é a saída?",
            "alternative_a": "1",
            "alternative_b": "2",
            "alternative_c": "3",
            "alternative_d": "4",
            "alternative_e": "5",
            "right_alternative": "A",
        }
    ]
    client.put(f"/api/v1/files/{file['id']}/questions", json={"questions": questions})

    response = client.get(f"/api/v1/folders/{folder['id']}/questions")
    assert response.status_code == 200
    assert len(response.json()) == 1


def test_missing_folder_returns_404(client):
    assert client.get("/api/v1/folders/inexistente").status_code == 404
