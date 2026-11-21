import os
import shutil
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()


def _resolve_binary(env_name: str, candidates: list[str], fallback: str) -> str:
    env_val = os.getenv(env_name, "").strip()
    if env_val:
        return env_val
    for candidate in candidates:
        if os.path.exists(candidate):
            return candidate
    found = shutil.which(fallback)
    return found or fallback


def _env_str(name: str, default: str) -> str:
    val = os.getenv(name)
    if val is None or not val.strip():
        return default
    return val.strip()


def _env_int(name: str, default: int) -> int:
    val = os.getenv(name)
    if val is None or not val.strip():
        return default
    try:
        parsed = int(val.strip())
        return parsed if parsed > 0 else default
    except ValueError:
        return default


class Config:
    BASE_DIR = Path(__file__).resolve().parent.parent
    HOST = _env_str("FLASK_HOST", "0.0.0.0")
    PORT = _env_int("FLASK_PORT", _env_int("PORT", 5000))
    DEBUG = _env_str("FLASK_DEBUG", "false").lower() == "true"

    TEMP_DIR = Path(_env_str("TEMP_DIR", "/tmp/clipfetch_jobs")).resolve()
    MAX_FILE_SIZE_MB = _env_int("MAX_FILE_SIZE_MB", 500)
    MAX_DURATION_SEC = _env_int("MAX_DURATION_SEC", 3600)
    MAX_CONCURRENT_JOBS = _env_int("MAX_CONCURRENT_JOBS", 4)
    JOB_TIMEOUT_SEC = _env_int("JOB_TIMEOUT_SEC", 600)
    AUTO_CLEANUP_MINUTES = _env_int("AUTO_CLEANUP_MINUTES", 15)

    YTDLP_BIN = _resolve_binary(
        "YTDLP_BIN",
        [str(BASE_DIR / "bin" / "yt-dlp"), "/usr/local/bin/yt-dlp", "/usr/bin/yt-dlp"],
        "yt-dlp",
    )
    FFMPEG_BIN = _resolve_binary("FFMPEG_BIN", ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg"], "ffmpeg")
    FFPROBE_BIN = _resolve_binary("FFPROBE_BIN", ["/usr/bin/ffprobe", "/usr/local/bin/ffprobe"], "ffprobe")
    NODE_BIN = _resolve_binary("NODE_BIN", ["/usr/local/bin/node", "/usr/bin/node"], "node")

    YTDLP_PROXY = os.getenv("YTDLP_PROXY", "").strip() or None
    COOKIES_FILE = os.getenv("YTDLP_COOKIES_FILE", "").strip() or None
    if COOKIES_FILE and not os.path.exists(COOKIES_FILE):
        COOKIES_FILE = None
    if not COOKIES_FILE:
        _b64_cookies = os.getenv("YTDLP_COOKIES_B64", "").strip()
        if _b64_cookies:
            try:
                import base64 as _b64

                _decoded = _b64.b64decode(_b64_cookies).decode("utf-8", errors="ignore").strip()
                if _decoded:
                    TEMP_DIR.mkdir(parents=True, exist_ok=True)
                    _env_cookie_path = TEMP_DIR / ".env_cookies.txt"
                    _env_cookie_path.write_text(_decoded + "\n", encoding="utf-8")
                    os.chmod(_env_cookie_path, 0o600)
                    COOKIES_FILE = str(_env_cookie_path)
            except Exception:
                pass

    # YouTube-only cookies. Render: Environment -> Secret Files -> filename "cookies.txt"
    # (it appears at /etc/secrets/cookies.txt, which is read-only, so we use a writable copy).
    YT_COOKIES_FILE = None
    _yt_src = _env_str("YT_COOKIES_FILE", "/etc/secrets/cookies.txt")
    if os.path.exists(_yt_src):
        try:
            TEMP_DIR.mkdir(parents=True, exist_ok=True)
            _yt_dst = TEMP_DIR / ".yt_cookies.txt"
            shutil.copyfile(_yt_src, _yt_dst)
            os.chmod(_yt_dst, 0o600)
            YT_COOKIES_FILE = str(_yt_dst)
        except Exception:
            YT_COOKIES_FILE = None
    if not YT_COOKIES_FILE:
        YT_COOKIES_FILE = COOKIES_FILE

    CORS_ORIGINS = os.getenv("CORS_ORIGINS", "*")
    ALLOWED_SPEEDS = (0.5, 1.0, 1.5, 2.0, 3.0)
    ALLOWED_VIDEO_CONTAINERS = ("mp4", "webm", "mkv")
    ALLOWED_AUDIO_CONTAINERS = ("mp3", "m4a")
