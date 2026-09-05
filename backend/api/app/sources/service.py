import logging
import re
import subprocess
import tempfile
from pathlib import Path

from app import config, errors
from app.sources.sites import get_site, list_supported_sites, load_fixture, scrape_web

logger = logging.getLogger(__name__)

TRANSCRIPT_TIMEOUT = 300
TITLE_TIMEOUT = 30
AUDIO_DOWNLOAD_TIMEOUT = 600


def fetch_content(url: str, language: str = "en", transcription_provider: str = "") -> tuple[str, str]:
    url = url.strip()
    if not url:
        raise errors.bad_request("URL não informada.")

    site = get_site(url)
    if site is None:
        supported = ", ".join(item["name"] for item in list_supported_sites())
        raise errors.bad_request(f"URL não suportada: '{url}'. Sites suportados: {supported}.")

    if site.name == "youtube":
        if config.test_mode():
            fixture = load_fixture("youtube_transcript_01.json")
            return fixture["title"], fixture["content"]
        return _youtube_content(url, language or "en", transcription_provider)

    if config.test_mode():
        fixture = load_fixture("web_content_01.json")
        return fixture["title"], fixture["content"]

    try:
        content = scrape_web(url)
    except RuntimeError as exc:
        raise errors.internal(str(exc))
    return _web_title(content, url), content


def _youtube_content(url: str, language: str, transcription_provider: str = "") -> tuple[str, str]:
    title = _youtube_title(url)
    try:
        result = subprocess.run(
            ["yt-dlp-transcript", "-l", language, "-v", url],
            capture_output=True,
            text=True,
            timeout=TRANSCRIPT_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        raise errors.internal(f"Timeout ao obter transcrição para: {url}")
    except FileNotFoundError:
        raise errors.internal("yt-dlp-transcript não encontrado no ambiente.")

    if result.returncode == 0 and result.stdout.strip():
        return title, result.stdout.strip()

    logger.warning(
        "yt-dlp-transcript sem legenda pra %s, caindo pro áudio: %s",
        url,
        result.stderr[:500] if result.stderr else "(sem saída)",
    )
    return title, _youtube_audio_fallback(url, language, transcription_provider)


def _youtube_audio_fallback(url: str, language: str, transcription_provider: str) -> str:
    from app.transcription.service import transcribe

    with tempfile.TemporaryDirectory() as tmpdir:
        outtmpl = str(Path(tmpdir) / "audio.%(ext)s")
        try:
            result = subprocess.run(
                ["yt-dlp", "-x", "--audio-format", "mp3", "--no-playlist", "-o", outtmpl, url],
                capture_output=True,
                text=True,
                timeout=AUDIO_DOWNLOAD_TIMEOUT,
            )
        except subprocess.TimeoutExpired:
            raise errors.internal(f"Timeout ao baixar áudio de: {url}")

        if result.returncode != 0:
            stderr = result.stderr[:1000] if result.stderr else "(sem saída)"
            raise errors.internal(f"Vídeo sem legenda e falha ao baixar áudio: {stderr}")

        audio_path = Path(tmpdir) / "audio.mp3"
        if not audio_path.exists():
            raise errors.internal("Áudio baixado não encontrado após a conversão.")

        return transcribe(audio_path, language=language, provider=transcription_provider)


def _youtube_title(url: str) -> str:
    try:
        result = subprocess.run(
            ["yt-dlp", "--print", "title", "--no-playlist", "--skip-download", url],
            capture_output=True,
            text=True,
            timeout=TITLE_TIMEOUT,
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    except Exception:
        logger.warning("Falha ao obter título do YouTube para %s", url)
    return "YouTube Video"


def _web_title(content: str, url: str) -> str:
    for line in content.split("\n"):
        stripped = line.strip()
        if re.match(r"^#{1,6}\s", stripped):
            return re.sub(r"^#+\s*", "", stripped).strip()
    return url
