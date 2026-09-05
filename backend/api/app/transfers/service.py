import io
import json
import zipfile
from typing import Any, Optional

from app import errors
from app.shared.frontmatter import add_frontmatter, parse_frontmatter


def parse_upload(filename: str, payload: bytes) -> dict[str, Any]:
    extension = (filename or "").rsplit(".", 1)[-1].lower()

    if extension == "md":
        meta, body = parse_frontmatter(payload.decode("utf-8", errors="replace"))
        result: dict[str, Any] = {"markdown": body}
        if meta.get("type"):
            result["type"] = meta["type"]
        return result

    if extension == "zip":
        return _parse_zip(payload)

    if extension == "pdf":
        return {"markdown": _pdf_text(payload)}

    raise errors.bad_request(f"Formato não suportado: {extension}. Aceitos: .md, .zip e .pdf.")


def _parse_zip(payload: bytes) -> dict[str, Any]:
    markdown = ""
    questions: Optional[Any] = None
    file_type: Optional[str] = None

    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        for entry in archive.namelist():
            if entry.endswith("/") or entry.startswith("__MACOSX/") or entry.startswith("."):
                continue
            content = archive.read(entry).decode("utf-8", errors="replace")
            if entry.endswith(".md"):
                meta, body = parse_frontmatter(content)
                markdown = body
                file_type = meta.get("type") or file_type
            elif entry.endswith(".json"):
                try:
                    questions = json.loads(content)
                except json.JSONDecodeError:
                    continue

    if not markdown:
        raise errors.bad_request("Nenhum arquivo .md encontrado no ZIP.")

    result: dict[str, Any] = {"markdown": markdown}
    if questions is not None:
        result["questions"] = questions
    if file_type:
        result["type"] = file_type
    return result


def _pdf_text(payload: bytes) -> str:
    from pypdf import PdfReader

    try:
        reader = PdfReader(io.BytesIO(payload))
        return "\n\n".join((page.extract_text() or "").strip() for page in reader.pages).strip()
    except Exception as error:  # noqa: BLE001
        raise errors.bad_request(f"Erro ao extrair texto do PDF: {error}")


def build_zip(markdown: str, questions: Any, filename: str, file_type: Optional[str]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(f"{filename}.md", add_frontmatter(markdown, file_type))
        if questions:
            archive.writestr(
                f"{filename}-questions.json",
                json.dumps(questions, ensure_ascii=False, indent=2),
            )
    return buffer.getvalue()
