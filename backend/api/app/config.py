import os


def _env(key: str, fallback: str = "") -> str:
    value = os.getenv(key)
    return value if value else fallback


def bind_host() -> str:
    return _env("BIND_HOST", "0.0.0.0")


def bind_port() -> int:
    return int(_env("BIND_PORT", "8000"))


def database_url() -> str:
    return _env("DATABASE_URL", "sqlite:///./data/study-helper.db")


def deepseek_api_key() -> str:
    return _env("DEEPSEEK_API_KEY")


def deepseek_base_url() -> str:
    return _env("DEEPSEEK_BASE_URL", "https://api.deepseek.com")


def deepseek_model() -> str:
    return _env("DEEPSEEK_TEXT_MODEL", "deepseek-v4-pro")


def test_mode() -> bool:
    return _env("TEST_MODE", "false").lower() == "true"


def debug_output() -> bool:
    return _env("DEBUG_OUTPUT", "false").lower() == "true"


def debug_output_dir() -> str:
    return _env("DEBUG_OUTPUT_DIR", "./.md")


def whisper_model() -> str:
    return _env("WHISPER_MODEL", "small")


def whisper_cache_dir() -> str:
    return _env("WHISPER_CACHE_DIR", "/data/whisper")


def max_upload_bytes() -> int:
    return int(_env("MAX_FILE_SIZE", str(200 * 1024 * 1024)))


def openai_api_key() -> str:
    return _env("OPENAI_API_KEY")


def openai_base_url() -> str:
    return _env("OPENAI_BASE_URL", "https://api.openai.com/v1")


def openai_audio_model() -> str:
    return _env("OPENAI_AUDIO_MODEL", "whisper-1")


def transcription_provider() -> str:
    return _env("TRANSCRIPTION_PROVIDER", "local")
