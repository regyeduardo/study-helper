import secrets
import uuid
from datetime import datetime, timezone

_ALFABETO_SEM_AMBIGUIDADE = "abcdefghjkmnpqrstuvwxyz23456789"


def new_id() -> str:
    return str(uuid.uuid4())


def new_hash() -> str:
    return "".join(secrets.choice(_ALFABETO_SEM_AMBIGUIDADE) for _ in range(8))


def utc_now() -> datetime:
    return datetime.now(timezone.utc)
