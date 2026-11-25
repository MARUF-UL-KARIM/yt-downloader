"""YouTube "modes" and a short-lived cache of the extracted info.

Modes (tried in this order until one works; the working one is remembered for 6 hours):
  vr      - one fast client (android_vr), no cookies, no JavaScript runtime needed
  plain   - yt-dlp default clients, no cookies
  cookies - yt-dlp default clients with the YouTube cookie file

The extracted info (formats incl. direct stream URLs) is kept for a few hours so that the
download can start from it directly instead of running a second full extraction.
"""
import json
import threading
import time

from backend.config import Config

MODES = [
    {"name": "vr", "cookies": False, "client": "android_vr"},
    {"name": "plain", "cookies": False, "client": None},
    {"name": "cookies", "cookies": True, "client": None},
]
MODE_TTL = 6 * 3600
INFO_TTL = 4 * 3600
INFO_MAX = 6

_lock = threading.Lock()
_info: dict[str, dict] = {}


def _state_path():
    return Config.TEMP_DIR / ".yt_mode.json"


def _available_modes() -> list[dict]:
    return [m for m in MODES if not m["cookies"] or Config.YT_COOKIES_FILE]


def _remembered_name() -> str | None:
    try:
        data = json.loads(_state_path().read_text())
        if time.time() - float(data["at"]) < MODE_TTL:
            return data["name"]
    except Exception:
        pass
    return None


def ordered_modes() -> list[dict]:
    modes = _available_modes()
    name = _remembered_name()
    first = [m for m in modes if m["name"] == name]
    return first + [m for m in modes if m["name"] != name]


def current_mode() -> dict:
    return ordered_modes()[0]


def remember(name: str) -> None:
    try:
        Config.TEMP_DIR.mkdir(parents=True, exist_ok=True)
        _state_path().write_text(json.dumps({"name": name, "at": time.time()}))
    except Exception:
        pass


def extractor_args(mode: dict | None) -> str:
    arg = "youtube:skip=translated_subs"
    if mode and mode.get("client"):
        arg += f";player_client={mode['client']}"
    return arg


def store_info(video_id: str | None, info: dict) -> None:
    if not video_id:
        return
    with _lock:
        _info[video_id] = {"at": time.time(), "info": info}
        for key in sorted(_info, key=lambda k: _info[k]["at"])[:-INFO_MAX]:
            _info.pop(key, None)


def get_info(video_id: str | None) -> dict | None:
    if not video_id:
        return None
    with _lock:
        entry = _info.get(video_id)
        if entry and time.time() - entry["at"] < INFO_TTL:
            return entry["info"]
    return None
