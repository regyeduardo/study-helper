def test_health(client):
    assert client.get("/api/v1/health").json() == {"status": "ok"}


def test_config_exposes_whisper_model(client):
    body = client.get("/api/v1/config").json()
    assert "whisper_model" in body
    assert "transcription_provider" in body
    assert "openai_available" in body


def test_ai_status(client):
    body = client.get("/api/v1/ai/status").json()
    assert "available" in body
    assert "text_model" in body


def test_supported_sites(client):
    names = [site["name"] for site in client.get("/api/v1/sources/sites").json()["sites"]]
    assert names == ["youtube", "web"]


def test_fetch_content_uses_fixture_in_test_mode(client):
    response = client.post(
        "/api/v1/sources/fetch", data={"url": "https://www.youtube.com/watch?v=abcdefghijk"}
    )
    assert response.status_code == 200
    assert response.json()["content"]


def test_fetch_content_rejects_unsupported_url(client):
    assert client.post("/api/v1/sources/fetch", data={"url": "ftp://x"}).status_code == 400


def test_transcription_endpoint_exists(client):
    assert client.post("/api/v1/transcriptions").status_code != 404
