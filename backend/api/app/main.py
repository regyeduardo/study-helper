import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import APIRouter, FastAPI, HTTPException
from fastapi.exception_handlers import http_exception_handler
from sqlmodel import Session, select

from app import config
from app.db import create_all, engine
from app.files.router import router as files_router
from app.folders.router import router as folders_router
from app.generation.deepseek import is_available, model_name
from app.generation.router import router as generations_router
from app.questions.router import router as questions_router
from app.sources.router import router as sources_router
from app.temp_files.router import router as temp_files_router
from app.transcription.router import router as transcription_router
from app.transfers.router import router as transfers_router

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    create_all()
    # Geração órfã — a API caiu/reiniciou no meio da geração e o job nunca
    # chegou ao finish (complete/error), deixando status=generating para sempre.
    # Isso travava Toda geração nova com 409 ("Já existe uma geração em
    # andamento"). Marca como error as presas ao subir o servidor.
    from app.shared.enums import TempFileStatus
    from app.temp_files.models import TempFile

    with Session(engine) as session:
        for temp_file in session.exec(
            select(TempFile).where(TempFile.status == TempFileStatus.generating)
        ).all():
            temp_file.status = TempFileStatus.error
            session.add(temp_file)
        session.commit()
    yield


app = FastAPI(title="Study Helper API", version="1.0.0", lifespan=lifespan)


@app.exception_handler(HTTPException)
async def logged_http_exception_handler(request, exc: HTTPException):
    # HTTPException (including our own errors.internal(...) 500s) is a "handled" exception to
    # FastAPI, so it never gets a traceback in the logs — only this message tells us why a
    # request failed. Without it a 500 shows up in the access log with zero context.
    if exc.status_code >= 500:
        logger.error("HTTP %d em %s %s: %s", exc.status_code, request.method, request.url.path, exc.detail)
    return await http_exception_handler(request, exc)


api = APIRouter(prefix="/api/v1")


@api.get("/health")
def health():
    return {"status": "ok"}


@api.get("/config")
def read_config():
    return {
        "whisper_model": config.whisper_model(),
        "transcription_provider": config.transcription_provider(),
        "openai_available": bool(config.openai_api_key()),
    }


@api.get("/ai/status")
def ai_status():
    available = is_available()
    return {"available": available, "text_model": model_name() if available else None}


api.include_router(folders_router)
api.include_router(files_router)
api.include_router(questions_router)
api.include_router(temp_files_router)
api.include_router(generations_router)
api.include_router(sources_router)
api.include_router(transcription_router)
api.include_router(transfers_router)

app.include_router(api)
