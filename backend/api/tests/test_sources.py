import subprocess
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

from app.sources import service


def _write_audio_from_outtmpl(cmd: list[str]) -> None:
    outtmpl = cmd[cmd.index("-o") + 1]
    audio_path = Path(outtmpl.replace("%(ext)s", "mp3"))
    audio_path.write_bytes(b"fake audio data")


def test_youtube_content_uses_transcript_when_available(monkeypatch):
    def fake_run(cmd, *args, **kwargs):
        if cmd[0] == "yt-dlp-transcript":
            return MagicMock(returncode=0, stdout="Legenda encontrada.\n", stderr="")
        if cmd[0] == "yt-dlp" and "--print" in cmd:
            return MagicMock(returncode=0, stdout="Título do vídeo\n", stderr="")
        raise AssertionError(f"não deveria baixar áudio: {cmd}")

    monkeypatch.setattr(subprocess, "run", fake_run)

    title, content = service._youtube_content("https://youtu.be/abc", "pt")
    assert title == "Título do vídeo"
    assert content == "Legenda encontrada."


def test_youtube_content_falls_back_to_audio_when_transcript_fails(monkeypatch):
    def fake_run(cmd, *args, **kwargs):
        if cmd[0] == "yt-dlp-transcript":
            return MagicMock(returncode=1, stdout="", stderr="sem legendas disponíveis")
        if cmd[0] == "yt-dlp" and "--print" in cmd:
            return MagicMock(returncode=0, stdout="Título do vídeo\n", stderr="")
        if cmd[0] == "yt-dlp" and "-x" in cmd:
            _write_audio_from_outtmpl(cmd)
            return MagicMock(returncode=0, stdout="", stderr="")
        raise AssertionError(f"comando inesperado: {cmd}")

    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.setattr(
        "app.transcription.service.transcribe",
        lambda path, language="", provider="": "Transcrito a partir do áudio.",
    )

    title, content = service._youtube_content("https://youtu.be/abc", "pt", "local")
    assert title == "Título do vídeo"
    assert content == "Transcrito a partir do áudio."


def test_youtube_content_falls_back_when_transcript_empty_but_returncode_zero(monkeypatch):
    def fake_run(cmd, *args, **kwargs):
        if cmd[0] == "yt-dlp-transcript":
            return MagicMock(returncode=0, stdout="   \n", stderr="")
        if cmd[0] == "yt-dlp" and "--print" in cmd:
            return MagicMock(returncode=0, stdout="Título do vídeo\n", stderr="")
        if cmd[0] == "yt-dlp" and "-x" in cmd:
            _write_audio_from_outtmpl(cmd)
            return MagicMock(returncode=0, stdout="", stderr="")
        raise AssertionError(f"comando inesperado: {cmd}")

    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.setattr(
        "app.transcription.service.transcribe",
        lambda path, language="", provider="": "Transcrito a partir do áudio.",
    )

    _, content = service._youtube_content("https://youtu.be/abc", "pt", "openai")
    assert content == "Transcrito a partir do áudio."


def test_youtube_content_raises_when_transcript_and_audio_both_fail(monkeypatch):
    def fake_run(cmd, *args, **kwargs):
        if cmd[0] == "yt-dlp-transcript":
            return MagicMock(returncode=1, stdout="", stderr="sem legendas disponíveis")
        if cmd[0] == "yt-dlp" and "--print" in cmd:
            return MagicMock(returncode=0, stdout="Título do vídeo\n", stderr="")
        if cmd[0] == "yt-dlp" and "-x" in cmd:
            return MagicMock(returncode=1, stdout="", stderr="vídeo indisponível")
        raise AssertionError(f"comando inesperado: {cmd}")

    monkeypatch.setattr(subprocess, "run", fake_run)

    with pytest.raises(HTTPException) as exc_info:
        service._youtube_content("https://youtu.be/abc", "pt")
    assert exc_info.value.status_code == 500
