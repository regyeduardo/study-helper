import logging
import mimetypes
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from functools import lru_cache
from pathlib import Path
from typing import Optional

import httpx
from fastapi import HTTPException

from app import config, errors

logger = logging.getLogger(__name__)

OPENAI_TIMEOUT = 300.0
# Sending too many chunks at once overwhelms the OpenAI endpoint (seen live: 38 chunks fired
# together produced a cascade of 500s) — cap how many upload in parallel.
MAX_CONCURRENT_UPLOADS = 5
MAX_CHUNK_RETRIES = 10
# Formats the OpenAI transcription endpoint accepts as-is; if the upload already matches one
# of these and fits the 25MB request limit, there's nothing for ffmpeg to fix.
OPENAI_NATIVE_EXTENSIONS = {"flac", "m4a", "mp3", "mp4", "mpeg", "mpga", "oga", "ogg", "wav", "webm"}
OPENAI_MAX_UPLOAD_BYTES = 24 * 1024 * 1024


def _ffprobe_duration(path: Path) -> Optional[float]:
    import subprocess

    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=True,
        )
        return float(result.stdout.strip())
    except Exception:
        return None


@lru_cache(maxsize=1)
def _model():
    from faster_whisper import WhisperModel

    return WhisperModel(
        config.whisper_model(),
        device="cpu",
        compute_type="int8",
        download_root=config.whisper_cache_dir(),
        # CTranslate2 models are safe under concurrent .transcribe() calls; num_workers
        # controls how many run truly in parallel instead of just queuing internally.
        # Now that tabs can generate at the same time, two audio jobs landing together
        # is the normal case, not the exception.
        num_workers=2,
        cpu_threads=4,
    )


def _transcribe_local(path: Path, language: str = "") -> str:
    try:
        segments, _ = _model().transcribe(
            str(path),
            language=language or None,
            vad_filter=True,
        )
        return " ".join(segment.text.strip() for segment in segments).strip()
    except Exception as error:
        logger.exception("transcrição local falhou")
        raise errors.internal(f"Falha ao transcrever o áudio: {error}")


def _transcribe_openai(path: Path, language: str = "") -> str:
    if config.test_mode():
        return "Transcrição de teste via OpenAI Audio API."

    api_key = config.openai_api_key()
    if not api_key:
        raise errors.bad_request("OPENAI_API_KEY não configurada.")

    base_url = config.openai_base_url().rstrip("/")
    url = f"{base_url}/audio/transcriptions"

    def _send_chunk(idx: int, total: int, chunk_path: Path, client: httpx.Client) -> str:
        chunk_duration = _ffprobe_duration(chunk_path)
        last_error = ""
        for attempt in range(1, MAX_CHUNK_RETRIES + 1):
            logger.info("Enviando pedaço %d/%d para OpenAI (%s), tentativa %d/%d", idx + 1, total, chunk_path.name, attempt, MAX_CHUNK_RETRIES)
            with chunk_path.open("rb") as f:
                files = {"file": (chunk_path.name, f, "audio/mp4")}
                # verbose_json traz "duration" e "segments" com timestamp, que o "json"
                # padrão (só "text") não dá — é o único jeito de saber se o Whisper
                # varreu o pedaço inteiro ou parou no meio, já que não guardamos o áudio
                # original pra reinspecionar depois.
                data = {"model": config.openai_audio_model(), "response_format": "verbose_json"}
                if language:
                    data["language"] = language

                try:
                    response = client.post(
                        url,
                        headers={"Authorization": f"Bearer {api_key}"},
                        files=files,
                        data=data,
                    )
                except httpx.TimeoutException:
                    last_error = "timeout"
                    logger.warning("Timeout no pedaço %s (tentativa %d/%d)", chunk_path.name, attempt, MAX_CHUNK_RETRIES)
                    time.sleep(min(2 * attempt, 20))
                    continue
                except Exception as error:
                    last_error = str(error)
                    logger.warning("Falha de rede no pedaço %s (tentativa %d/%d): %s", chunk_path.name, attempt, MAX_CHUNK_RETRIES, error)
                    time.sleep(min(2 * attempt, 20))
                    continue

                if response.status_code != 200:
                    error_message = response.text
                    try:
                        err_data = response.json()
                        if "error" in err_data and "message" in err_data["error"]:
                            error_message = err_data["error"]["message"]
                    except Exception:
                        pass
                    # 4xx (chave inválida, arquivo rejeitado, etc.) não melhora tentando de
                    # novo — só 5xx/erro de rede/timeout são transitórios e valem retry.
                    if response.status_code < 500:
                        logger.error("OpenAI retornou status %d no pedaço %s: %s", response.status_code, chunk_path.name, error_message)
                        raise errors.internal(f"Erro na OpenAI Audio API: {error_message}")
                    last_error = error_message
                    logger.warning(
                        "OpenAI retornou status %d no pedaço %s (tentativa %d/%d): %s",
                        response.status_code, chunk_path.name, attempt, MAX_CHUNK_RETRIES, error_message,
                    )
                    time.sleep(min(2 * attempt, 20))
                    continue

                result_json = response.json()
                text = result_json.get("text", "").strip()
                segments = result_json.get("segments") or []
                last_segment_end = segments[-1]["end"] if segments else None
                logger.info(
                    "Pedaço %s: enviado com %.1fs, OpenAI processou %.1fs, último segmento termina em %s, %d segmento(s), %d caractere(s) de texto",
                    chunk_path.name, chunk_duration or -1, result_json.get("duration") or -1,
                    last_segment_end, len(segments), len(text),
                )
                return text

        logger.error("Pedaço %s falhou após %d tentativas: %s", chunk_path.name, MAX_CHUNK_RETRIES, last_error)
        raise errors.internal(f"Falha ao transcrever pedaço {chunk_path.name} após {MAX_CHUNK_RETRIES} tentativas: {last_error}")

    def _send_all(chunks: list[Path]) -> str:
        # No máximo MAX_CONCURRENT_UPLOADS pedaços em voo por vez — mandar todos de uma vez
        # (sem limite) sobrecarrega a OpenAI e derruba a maioria com 500/400 em cascata.
        transcripts: list[str] = [""] * len(chunks)
        with httpx.Client(timeout=OPENAI_TIMEOUT) as client:
            with ThreadPoolExecutor(max_workers=min(MAX_CONCURRENT_UPLOADS, len(chunks))) as executor:
                futures = {
                    executor.submit(_send_chunk, idx, len(chunks), chunk_path, client): idx
                    for idx, chunk_path in enumerate(chunks)
                }
                for future in as_completed(futures):
                    idx = futures[future]
                    transcripts[idx] = future.result()
        return " ".join(t for t in transcripts if t).strip()

    # Já veio num formato que a OpenAI aceita direto e cabe no limite de 25MB — nada pra
    # ffmpeg converter. Só reprocessa quando for realmente preciso (formato não aceito, ou
    # grande demais e precisa ser fatiado).
    extension = path.suffix.lower().lstrip(".")
    file_size = path.stat().st_size
    if extension in OPENAI_NATIVE_EXTENSIONS and file_size <= OPENAI_MAX_UPLOAD_BYTES:
        logger.info(
            "Áudio já está num formato aceito pela OpenAI (%s, %.1f MB) — enviando sem converter: %s",
            extension, file_size / (1024 * 1024), path.name,
        )
        return _send_all([path])

    import os
    import subprocess
    import tempfile

    with tempfile.TemporaryDirectory() as tmpdir:
        # Extrai o áudio, converte para m4a (aac) 48kbps, mono, dividindo em fatias de 20 minutos (1200s).
        # A ~48kbps, 20 minutos dá ~7.2 MB, superando tranquilamente o limite de 25 MB da OpenAI.
        pattern = os.path.join(tmpdir, "chunk_%03d.m4a")
        cmd = [
            "ffmpeg",
            "-y",
            "-i", str(path),
            "-vn",
            "-ac", "1",
            "-c:a", "aac",
            "-b:a", "48k",
            "-f", "segment",
            "-segment_time", "1200",
            "-reset_timestamps", "1",
            pattern
        ]

        try:
            logger.info("Extraindo áudio e convertendo para m4a (mono 48kbps): %s", path.name)
            subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=True)
        except subprocess.CalledProcessError as e:
            logger.error("Falha ao fatiar o áudio com ffmpeg: %s", e.stderr)
            raise errors.internal("Falha ao preparar o áudio para envio à OpenAI.")

        chunks = sorted(Path(tmpdir).glob("chunk_*.m4a"))
        if not chunks:
            raise errors.internal("Nenhum segmento de áudio gerado após a conversão.")

        total_size = sum(c.stat().st_size for c in chunks)
        logger.info(
            "Conversão concluída: %d pedaço(s) m4a gerados (%.1f MB total) a partir de %s",
            len(chunks), total_size / (1024 * 1024), path.name,
        )

        return _send_all(chunks)


def transcribe(path: Path, language: str = "", provider: Optional[str] = None) -> str:
    chosen_provider = (provider or config.transcription_provider() or "local").strip().lower()

    if chosen_provider in ("openai", "cloud"):
        return _transcribe_openai(path, language=language)

    return _transcribe_local(path, language=language)

