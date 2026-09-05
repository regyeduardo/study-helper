import tempfile
from pathlib import Path

from fastapi import APIRouter, File, Form, UploadFile
from pydantic import BaseModel

from app.transcription import service

router = APIRouter(prefix="/transcriptions", tags=["transcriptions"])


class TranscriptionResult(BaseModel):
    text: str


@router.post("", response_model=TranscriptionResult)
async def create_transcription(
    file: UploadFile = File(...),
    language: str = Form(""),
    provider: str = Form(""),
):
    suffix = Path(file.filename or "audio").suffix
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as handle:
        handle.write(await file.read())
        temp_path = Path(handle.name)

    try:
        text = service.transcribe(temp_path, language=language, provider=provider)
    finally:
        temp_path.unlink(missing_ok=True)

    return TranscriptionResult(text=text)
