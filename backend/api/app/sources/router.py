from fastapi import APIRouter, Form
from pydantic import BaseModel

from app.sources import service
from app.sources.sites import list_supported_sites

router = APIRouter(prefix="/sources", tags=["sources"])


class FetchResult(BaseModel):
    title: str
    content: str


@router.get("/sites")
def supported_sites():
    return {"sites": list_supported_sites()}


@router.post("/fetch", response_model=FetchResult)
def fetch(url: str = Form(...), language: str = Form("en")):
    title, content = service.fetch_content(url, language)
    return FetchResult(title=title, content=content)
