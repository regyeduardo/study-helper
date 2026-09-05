import pytest


def question(letter: str = "A") -> dict:
    return {
        "statement": "Pergunta?",
        "alternative_a": "a",
        "alternative_b": "b",
        "alternative_c": "c",
        "alternative_d": "d",
        "alternative_e": "e",
        "right_alternative": letter,
        "explanation": "porque sim",
    }


def test_replace_and_list_questions(client, file):
    response = client.put(
        f"/api/v1/files/{file['id']}/questions", json={"questions": [question(), question("B")]}
    )
    assert response.status_code == 200
    assert len(response.json()) == 2

    listed = client.get(f"/api/v1/files/{file['id']}/questions").json()
    assert len(listed) == 2
    assert listed[0]["file_id"] == file["id"]


def test_replace_overwrites_previous_questions(client, file):
    client.put(f"/api/v1/files/{file['id']}/questions", json={"questions": [question()] * 3})
    client.put(f"/api/v1/files/{file['id']}/questions", json={"questions": [question("C")]})

    listed = client.get(f"/api/v1/files/{file['id']}/questions").json()
    assert len(listed) == 1
    assert listed[0]["right_alternative"] == "C"


def test_delete_questions(client, file):
    client.put(f"/api/v1/files/{file['id']}/questions", json={"questions": [question()]})
    assert client.delete(f"/api/v1/files/{file['id']}/questions").status_code == 204
    assert client.get(f"/api/v1/files/{file['id']}/questions").json() == []


def test_questions_count_appears_in_file(client, file):
    client.put(f"/api/v1/files/{file['id']}/questions", json={"questions": [question(), question()]})
    assert client.get(f"/api/v1/files/{file['id']}").json()["questions_count"] == 2


def test_questions_require_existing_file(client):
    response = client.put("/api/v1/files/inexistente/questions", json={"questions": [question()]})
    assert response.status_code == 404


@pytest.mark.parametrize("letter", ["A", "B", "C", "D", "E"])
def test_accepts_every_alternative(client, file, letter):
    response = client.put(f"/api/v1/files/{file['id']}/questions", json={"questions": [question(letter)]})
    assert response.status_code == 200


def test_rejects_invalid_alternative(client, file):
    response = client.put(f"/api/v1/files/{file['id']}/questions", json={"questions": [question("F")]})
    assert response.status_code == 422
