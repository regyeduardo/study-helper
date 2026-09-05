import json
import logging
from collections.abc import Callable, Iterator
from queue import Queue
from threading import Thread
from typing import Any

logger = logging.getLogger(__name__)

SSE_HEADERS = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}


def format_event(event: str, data: Any) -> str:
    payload = data if isinstance(data, str) else json.dumps(data, ensure_ascii=False)
    return f"event: {event}\ndata: {payload}\n\n"


def stream(job: Callable[[Callable[[str, Any], None]], None]) -> Iterator[str]:
    queue: Queue = Queue()

    def emit(event: str, data: Any) -> None:
        queue.put((event, data))

    def run() -> None:
        try:
            job(emit)
        except Exception as error:  # noqa: BLE001
            logger.exception("Falha na geração")
            queue.put(("error", {"message": str(error)}))
        finally:
            queue.put(None)

    thread = Thread(target=run, daemon=True)
    thread.start()

    while True:
        item = queue.get()
        if item is None:
            break
        yield format_event(item[0], item[1])
