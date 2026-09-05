import re
from pathlib import Path

MEDIA_EXTENSIONS = {
    "mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus", "wma", "aiff",
    "mp4", "webm", "avi", "mkv", "mov", "wmv", "flv", "mpeg", "mpg", "m4v", "3gp",
}

SUBTITLE_EXTENSIONS = {"srt", "vtt", "sbv", "ass", "ssa", "sub"}

TEXT_EXTENSIONS = {
    "txt", "md", "markdown", "csv", "tsv", "json", "xml", "html", "htm", "yml", "yaml",
    "log", "rst", "org", "tex", "py", "js", "ts", "go", "java", "rb", "rs", "c", "cpp", "sql",
}

_TIMESTAMP_RE = re.compile(r"^\s*[\d:.,]+\s*-->\s*[\d:.,]+.*$")
_INDEX_RE = re.compile(r"^\s*\d+\s*$")
_TAG_RE = re.compile(r"</?[a-zA-Z][^>]*>|\{[^}]*\}")
_ASS_EVENT_RE = re.compile(r"^Dialogue:\s*(?:[^,]*,){9}(.*)$")
_SUBTITLE_HINT_RE = re.compile(r"-->|^Dialogue:", re.MULTILINE)


def detect_kind(filename: str, payload: bytes) -> str:
    extension = Path(filename or "").suffix.lower().lstrip(".")

    if extension == "pdf" or payload[:5] == b"%PDF-":
        return "pdf"

    if extension == "docx":
        return "docx"

    # Legacy binary .doc (pre-2007) has no text extractor here — flagged separately so it
    # gets a clear "convert to .docx" error instead of silently falling through to "media"
    # and being sent to ffmpeg/Whisper as if it were audio.
    if extension == "doc":
        return "doc_legacy"

    if extension in SUBTITLE_EXTENSIONS:
        return "subtitle"

    if extension in MEDIA_EXTENSIONS:
        return "media"

    if not looks_like_text(payload):
        return "media"

    if _SUBTITLE_HINT_RE.search(decode(payload)[:4000]):
        return "subtitle"

    return "text"


def decode(payload: bytes) -> str:
    for encoding in ("utf-8", "latin-1"):
        try:
            return payload.decode(encoding)
        except UnicodeDecodeError:
            continue
    return payload.decode("utf-8", errors="replace")


def looks_like_text(payload: bytes) -> bool:
    if not payload:
        return True

    sample = payload[:4096]
    if b"\x00" in sample:
        return False

    try:
        sample.decode("utf-8")
        return True
    except UnicodeDecodeError:
        pass

    printable = sum(1 for byte in sample if byte in (9, 10, 13) or 32 <= byte < 127 or byte >= 160)
    return printable / len(sample) > 0.9


def subtitle_to_text(content: str) -> str:
    lines: list[str] = []

    for raw_line in content.replace("\r\n", "\n").split("\n"):
        line = raw_line.strip()

        if not line or line.upper().startswith("WEBVTT"):
            continue
        if _INDEX_RE.match(line) or _TIMESTAMP_RE.match(line):
            continue
        if line.startswith("[") and line.endswith("]"):
            continue
        if line.startswith(("Format:", "Style:", "ScriptType:", "Title:", "Collisions:", "PlayResX", "PlayResY")):
            continue

        dialogue = _ASS_EVENT_RE.match(line)
        if dialogue:
            line = dialogue.group(1).replace("\\N", " ")

        line = _TAG_RE.sub("", line).strip()
        if not line:
            continue
        if lines and lines[-1] == line:
            continue

        lines.append(line)

    return " ".join(lines).strip()
