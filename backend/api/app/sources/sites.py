import json
import logging
import re
import subprocess
from pathlib import Path
from typing import Callable, Optional

logger = logging.getLogger(__name__)

FIXTURE_DIR = Path(__file__).resolve().parents[2] / "testdata" / "fixtures"

PREFLIGHT_TIMEOUT = 30
YT_DLP_TIMEOUT = 120

YOUTUBE_URL_PATTERN = re.compile(
    r"^(https?://)?(www\.)?"
    r"(youtube\.com/(watch\?v=|embed/|v/|shorts/|live/)|youtu\.be/)"
    r"[a-zA-Z0-9_-]{11}"
    r"([&?]\S*)?$"
)

WEB_URL_PATTERN = re.compile(r"^https?://[^\s/$.?#].[^\s]*$")


def load_fixture(filename: str) -> dict:
    fixture_path = FIXTURE_DIR / filename
    if not fixture_path.exists():
        raise FileNotFoundError(f"Fixture não encontrada: {fixture_path}")
    with open(fixture_path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def validate_youtube(url: str) -> bool:
    return bool(YOUTUBE_URL_PATTERN.match(url.strip()))


def validate_web(url: str) -> bool:
    return bool(WEB_URL_PATTERN.match(url.strip()))


def download_youtube(url: str, output_dir: Path) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    output_template = str(output_dir / "%(title)s.%(ext)s")

    preflight = subprocess.run(
        [
            "yt-dlp",
            "--simulate",
            "--no-playlist",
            "--ignore-errors",
            "--js-runtimes",
            "node",
            "-f",
            "bestvideo[protocol!=m3u8]+bestaudio[protocol!=m3u8]/best[protocol!=m3u8]",
            url,
        ],
        capture_output=True,
        text=True,
        timeout=PREFLIGHT_TIMEOUT,
    )
    if preflight.returncode != 0:
        stderr = preflight.stderr[:800] if preflight.stderr else "(sem saída)"
        raise RuntimeError(f"Não foi possível baixar este vídeo. Erro: {stderr}")

    result = subprocess.run(
        ["yt-dlp-proxy", "-t", "aac", "--js-runtimes", "node", "-o", output_template, url],
        capture_output=True,
        text=True,
        timeout=YT_DLP_TIMEOUT,
    )
    if result.returncode != 0:
        stderr = result.stderr[:500] if result.stderr else "(sem saída)"
        raise RuntimeError(f"Falha ao baixar: {stderr}")

    files = list(output_dir.iterdir())
    if not files:
        raise RuntimeError("Nenhum arquivo encontrado após o download.")

    mp3 = [item for item in files if item.suffix.lower() == ".mp3"]
    return mp3[0] if mp3 else max(files, key=lambda item: item.stat().st_size)


def scrape_web(url: str) -> str:
    import trafilatura

    downloaded = trafilatura.fetch_url(url)
    if downloaded is None:
        raise RuntimeError(f"Não foi possível acessar a URL: {url}")

    extracted = trafilatura.extract(
        downloaded,
        output_format="markdown",
        include_links=False,
        include_images=False,
        include_tables=True,
        include_comments=False,
        no_fallback=False,
    )
    if not extracted:
        raise RuntimeError(f"Não foi possível extrair conteúdo de: {url}")
    return extracted


class SiteInfo:
    def __init__(self, name: str, patterns: list[str], validate: Callable[[str], bool]):
        self.name = name
        self.patterns = patterns
        self.validate = validate


SITES: dict[str, SiteInfo] = {
    "youtube": SiteInfo("youtube", ["youtube.com/*", "youtu.be/*"], validate_youtube),
    "web": SiteInfo("web", ["http://*", "https://*"], validate_web),
}


def get_site(url: str) -> Optional[SiteInfo]:
    url = url.strip()
    for site in SITES.values():
        if site.validate(url):
            return site
    return None


def list_supported_sites() -> list[dict]:
    return [{"name": site.name, "patterns": site.patterns} for site in SITES.values()]
