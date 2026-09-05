import pytest

from app.generation import uploads

SRT = """1
00:00:01,000 --> 00:00:04,000
Bem-vindo à aula de redes.

2
00:00:04,500 --> 00:00:07,200
Hoje vamos falar do <i>protocolo TCP</i>.

3
00:00:07,200 --> 00:00:09,000
Hoje vamos falar do protocolo TCP.
"""

VTT = """WEBVTT

00:00:01.000 --> 00:00:03.000 line:80%
Primeira fala.

00:00:03.500 --> 00:00:06.000
Segunda fala.
"""


def test_detects_subtitle_by_extension():
    assert uploads.detect_kind("aula.srt", SRT.encode()) == "subtitle"
    assert uploads.detect_kind("aula.vtt", VTT.encode()) == "subtitle"


def test_detects_subtitle_even_with_wrong_extension():
    assert uploads.detect_kind("aula.legenda", SRT.encode()) == "subtitle"


def test_detects_media_by_extension():
    assert uploads.detect_kind("aula.mp3", b"\x00\x01binario") == "media"
    assert uploads.detect_kind("aula.mp4", b"\x00\x01binario") == "media"


def test_detects_pdf():
    assert uploads.detect_kind("aula.pdf", b"%PDF-1.7 ...") == "pdf"


def test_detects_plain_text_for_unknown_text_extension():
    assert uploads.detect_kind("notas.anotacao", "conteúdo qualquer".encode()) == "text"


def test_detects_text_without_extension():
    assert uploads.detect_kind("notas", b"apenas texto") == "text"


def test_detects_media_for_binary_without_known_extension():
    assert uploads.detect_kind("gravacao.xyz", bytes(range(0, 32)) * 40) == "media"


def test_subtitle_to_text_drops_timestamps_and_indexes():
    text = uploads.subtitle_to_text(SRT)

    assert "00:00:01" not in text
    assert "-->" not in text
    assert text.startswith("Bem-vindo à aula de redes.")
    assert "<i>" not in text
    assert "protocolo TCP" in text


def test_subtitle_to_text_removes_repeated_consecutive_lines():
    text = uploads.subtitle_to_text(SRT)
    assert text.count("Hoje vamos falar do protocolo TCP.") == 1


def test_subtitle_to_text_handles_vtt_header_and_cue_settings():
    text = uploads.subtitle_to_text(VTT)

    assert "WEBVTT" not in text
    assert "line:80%" not in text
    assert text == "Primeira fala. Segunda fala."


def test_looks_like_text_accepts_utf8_and_latin1():
    assert uploads.looks_like_text("olá mundo".encode("utf-8"))
    assert uploads.looks_like_text("olá mundo".encode("latin-1"))


def test_looks_like_text_rejects_binary():
    assert not uploads.looks_like_text(bytes(range(0, 32)) * 40)


@pytest.mark.parametrize("extension", ["srt", "vtt", "ass", "ssa", "sbv"])
def test_every_subtitle_extension_is_text(extension):
    assert uploads.detect_kind(f"aula.{extension}", b"1\n00:00:01,000 --> 00:00:02,000\nfala\n") == "subtitle"
