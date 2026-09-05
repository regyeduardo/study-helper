import threading
from pathlib import Path
from unittest.mock import MagicMock

import httpx
import pytest
from fastapi import HTTPException

from app.transcription import service


def test_transcribe_openai_test_mode(tmp_path, monkeypatch):
    monkeypatch.setenv("TEST_MODE", "true")
    audio_file = tmp_path / "sample.mp3"
    audio_file.write_bytes(b"fake audio data")

    result = service.transcribe(audio_file, provider="openai")
    assert "OpenAI" in result


def test_transcribe_openai_missing_api_key(tmp_path, monkeypatch):
    monkeypatch.setenv("TEST_MODE", "false")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    audio_file = tmp_path / "sample.mp3"
    audio_file.write_bytes(b"fake audio data")

    with pytest.raises(HTTPException) as exc_info:
        service.transcribe(audio_file, provider="openai")
    assert exc_info.value.status_code == 400
    assert "OPENAI_API_KEY" in exc_info.value.detail


def test_transcribe_openai_success(tmp_path, monkeypatch):
    monkeypatch.setenv("TEST_MODE", "false")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
    audio_file = tmp_path / "sample.mp3"
    audio_file.write_bytes(b"fake audio data")

    # Mock subprocess.run to simulate ffmpeg producing one chunk
    def mock_subprocess_run(cmd, *args, **kwargs):
        # Create a dummy chunk in the output directory
        # The output pattern is the last argument: /tmp/tmp_xyz/chunk_%03d.m4a
        out_pattern = cmd[-1]
        out_dir = Path(out_pattern).parent
        chunk = out_dir / "chunk_000.m4a"
        chunk.write_bytes(b"dummy chunk data")
        return MagicMock(returncode=0)
    import subprocess
    monkeypatch.setattr(subprocess, "run", mock_subprocess_run)

    def mock_post(self, url, *args, **kwargs):
        req = httpx.Request("POST", url)
        return httpx.Response(200, json={"text": "Texto transcrito com sucesso pela OpenAI."}, request=req)

    monkeypatch.setattr(httpx.Client, "post", mock_post)

    result = service.transcribe(audio_file, language="pt", provider="openai")
    assert result == "Texto transcrito com sucesso pela OpenAI."


def test_transcribe_openai_api_error(tmp_path, monkeypatch):
    monkeypatch.setenv("TEST_MODE", "false")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    audio_file = tmp_path / "sample.mp3"
    audio_file.write_bytes(b"fake audio data")

    # Mock subprocess.run
    def mock_subprocess_run(cmd, *args, **kwargs):
        out_pattern = cmd[-1]
        out_dir = Path(out_pattern).parent
        chunk = out_dir / "chunk_000.m4a"
        chunk.write_bytes(b"dummy chunk data")
        return MagicMock(returncode=0)
    import subprocess
    monkeypatch.setattr(subprocess, "run", mock_subprocess_run)

    def mock_post(self, url, *args, **kwargs):
        req = httpx.Request("POST", url)
        return httpx.Response(
            401,
            json={"error": {"message": "Invalid API key"}},
            request=req,
        )

    monkeypatch.setattr(httpx.Client, "post", mock_post)

    with pytest.raises(HTTPException) as exc_info:
        service.transcribe(audio_file, provider="openai")
    assert exc_info.value.status_code == 500
    assert "Invalid API key" in exc_info.value.detail


def test_transcribe_local_delegation(tmp_path, monkeypatch):
    audio_file = tmp_path / "sample.mp3"
    audio_file.write_bytes(b"fake audio data")

    mock_model = MagicMock()
    mock_segment = MagicMock()
    mock_segment.text = " Transcrição local do whisper. "
    mock_model.transcribe.return_value = ([mock_segment], None)

    monkeypatch.setattr(service, "_model", lambda: mock_model)

    result = service.transcribe(audio_file, language="pt", provider="local")
    assert result == "Transcrição local do whisper."
    mock_model.transcribe.assert_called_once()


def test_transcription_endpoint_with_provider(client, monkeypatch):
    monkeypatch.setattr(
        service,
        "transcribe",
        lambda path, language="", provider="": f"transcrito via {provider or 'default'}",
    )

    response = client.post(
        "/api/v1/transcriptions",
        files={"file": ("aula.mp3", b"dummy audio content", "audio/mpeg")},
        data={"language": "pt", "provider": "openai"},
    )
    assert response.status_code == 200
    assert response.json() == {"text": "transcrito via openai"}


def test_transcribe_openai_multi_chunk(tmp_path, monkeypatch):
    """When ffmpeg produces multiple chunks, all are sent (in parallel) and texts are concatenated in chunk order."""
    monkeypatch.setenv("TEST_MODE", "false")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    # .mkv isn't in OPENAI_NATIVE_EXTENSIONS, so this always goes through ffmpeg — the
    # chunking path under test — regardless of file size.
    audio_file = tmp_path / "long_lecture.mkv"
    audio_file.write_bytes(b"fake long video data")

    # Mock subprocess.run to simulate ffmpeg producing 3 chunks
    def mock_subprocess_run(cmd, *args, **kwargs):
        out_pattern = cmd[-1]
        out_dir = Path(out_pattern).parent
        for i in range(3):
            chunk = out_dir / f"chunk_{i:03d}.m4a"
            chunk.write_bytes(b"dummy chunk data")
        return MagicMock(returncode=0)
    import subprocess
    monkeypatch.setattr(subprocess, "run", mock_subprocess_run)

    # Requests now fire concurrently, so the mock must map each request to its own chunk by
    # filename (via the uploaded "files" kwarg) instead of a shared call-order counter.
    chunk_texts = {
        "chunk_000.m4a": "Parte um da aula.",
        "chunk_001.m4a": "Parte dois da aula.",
        "chunk_002.m4a": "Parte três da aula.",
    }
    calls = []
    calls_lock = threading.Lock()

    def mock_post(self, url, *args, **kwargs):
        filename = kwargs["files"]["file"][0]
        with calls_lock:
            calls.append(filename)
        req = httpx.Request("POST", url)
        return httpx.Response(200, json={"text": chunk_texts[filename]}, request=req)

    monkeypatch.setattr(httpx.Client, "post", mock_post)

    result = service.transcribe(audio_file, language="pt", provider="openai")
    assert len(calls) == 3
    assert result == "Parte um da aula. Parte dois da aula. Parte três da aula."


def test_transcribe_openai_ffmpeg_failure(tmp_path, monkeypatch):
    """When ffmpeg fails, a clear error is raised."""
    monkeypatch.setenv("TEST_MODE", "false")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    # .mkv isn't in OPENAI_NATIVE_EXTENSIONS, so this always goes through ffmpeg.
    audio_file = tmp_path / "bad.mkv"
    audio_file.write_bytes(b"corrupt data")

    import subprocess
    def mock_subprocess_run(cmd, *args, **kwargs):
        raise subprocess.CalledProcessError(1, cmd, stderr="Invalid data found")
    monkeypatch.setattr(subprocess, "run", mock_subprocess_run)

    with pytest.raises(HTTPException) as exc_info:
        service.transcribe(audio_file, provider="openai")
    assert exc_info.value.status_code == 500
    assert "preparar o áudio" in exc_info.value.detail


def test_transcribe_openai_skips_conversion_for_native_format(tmp_path, monkeypatch):
    """A small file already in a format the OpenAI endpoint accepts is sent as-is, no ffmpeg."""
    monkeypatch.setenv("TEST_MODE", "false")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    audio_file = tmp_path / "aula.mp3"
    audio_file.write_bytes(b"real-looking mp3 bytes")

    import subprocess
    def mock_subprocess_run(cmd, *args, **kwargs):
        raise AssertionError("ffmpeg should not run for a native, small file")
    monkeypatch.setattr(subprocess, "run", mock_subprocess_run)

    def mock_post(self, url, *args, **kwargs):
        assert kwargs["files"]["file"][0] == "aula.mp3"  # the original file, untouched
        req = httpx.Request("POST", url)
        return httpx.Response(200, json={"text": "Transcrição direta, sem conversão."}, request=req)

    monkeypatch.setattr(httpx.Client, "post", mock_post)

    result = service.transcribe(audio_file, provider="openai")
    assert result == "Transcrição direta, sem conversão."


def test_transcribe_openai_converts_native_format_when_too_large(tmp_path, monkeypatch):
    """A native-format file over the 25MB request limit still needs ffmpeg to chunk it."""
    monkeypatch.setenv("TEST_MODE", "false")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    audio_file = tmp_path / "aula_longa.mp3"
    audio_file.write_bytes(b"0" * (service.OPENAI_MAX_UPLOAD_BYTES + 1))

    ran_ffmpeg = False

    import subprocess
    def mock_subprocess_run(cmd, *args, **kwargs):
        nonlocal ran_ffmpeg
        ran_ffmpeg = True
        out_dir = Path(cmd[-1]).parent
        (out_dir / "chunk_000.m4a").write_bytes(b"dummy chunk data")
        return MagicMock(returncode=0)
    monkeypatch.setattr(subprocess, "run", mock_subprocess_run)

    def mock_post(self, url, *args, **kwargs):
        req = httpx.Request("POST", url)
        return httpx.Response(200, json={"text": "ok"}, request=req)
    monkeypatch.setattr(httpx.Client, "post", mock_post)

    service.transcribe(audio_file, provider="openai")
    assert ran_ffmpeg


def test_transcribe_openai_retries_on_5xx_then_succeeds(tmp_path, monkeypatch):
    """Transient 5xx errors are retried, not treated as final failures."""
    monkeypatch.setenv("TEST_MODE", "false")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setattr(service.time, "sleep", lambda *_: None)
    audio_file = tmp_path / "aula.mp3"
    audio_file.write_bytes(b"fake audio")

    attempts = {"n": 0}

    def mock_post(self, url, *args, **kwargs):
        attempts["n"] += 1
        req = httpx.Request("POST", url)
        if attempts["n"] < 3:
            return httpx.Response(500, json={"error": {"message": "temporary overload"}}, request=req)
        return httpx.Response(200, json={"text": "Recuperou depois de tentar de novo."}, request=req)

    monkeypatch.setattr(httpx.Client, "post", mock_post)

    result = service.transcribe(audio_file, provider="openai")
    assert attempts["n"] == 3
    assert result == "Recuperou depois de tentar de novo."


def test_transcribe_openai_fails_after_max_retries(tmp_path, monkeypatch):
    """A chunk that keeps failing with 5xx exhausts its retries and fails the whole transcription."""
    monkeypatch.setenv("TEST_MODE", "false")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setattr(service.time, "sleep", lambda *_: None)
    audio_file = tmp_path / "aula.mp3"
    audio_file.write_bytes(b"fake audio")

    attempts = {"n": 0}

    def mock_post(self, url, *args, **kwargs):
        attempts["n"] += 1
        req = httpx.Request("POST", url)
        return httpx.Response(503, json={"error": {"message": "still overloaded"}}, request=req)

    monkeypatch.setattr(httpx.Client, "post", mock_post)

    with pytest.raises(HTTPException) as exc_info:
        service.transcribe(audio_file, provider="openai")
    assert exc_info.value.status_code == 500
    assert attempts["n"] == service.MAX_CHUNK_RETRIES
    assert "10 tentativas" in exc_info.value.detail
