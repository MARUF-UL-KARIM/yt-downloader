"""Remembers whether YouTube works better WITHOUT the cookie file on this server.

With cookies, yt-dlp must use clients that need a JavaScript runtime; without cookies it can
use clients that do not. If the with-cookies attempt fails and the without-cookies attempt
works, we prefer the latter for the next hour (analysis and downloads).
"""
import time

_PREFER_FOR = 60 * 60
_since: float | None = None


def prefer_no_cookies() -> bool:
    return _since is not None and time.time() - _since < _PREFER_FOR


def set_prefer_no_cookies(value: bool) -> None:
    global _since
    _since = time.time() if value else None
