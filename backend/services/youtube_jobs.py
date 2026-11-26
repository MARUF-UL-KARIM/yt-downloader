"""Background analysis for YouTube links.

Small free servers are slow at YouTube's JavaScript challenge. A single HTTP request that
waits minutes gets cut by the hosting proxy (the browser then receives an HTML error page).
So the analysis runs in a background thread and the browser polls:

* one YouTube analysis at a time (parallel yt-dlp runs starve a tiny CPU)
* the same link requested again joins the run in progress instead of starting another
* finished results are kept for 15 minutes, failures for 2 minutes
"""
import threading
import time
import traceback

from backend.services import yt_state
from backend.services.extractor import analyze_media_url
from backend.utils.validators import youtube_video_id

RESULT_TTL = 15 * 60
ERROR_TTL = 2 * 60

_lock = threading.Lock()
_gate = threading.Semaphore(1)
_jobs: dict[str, dict] = {}


def _analyze(url: str) -> dict:
    """Try the remembered working mode first, then the others, until one works."""
    left = yt_state.blocked_seconds_left()
    if left > 0:
        raise ValueError(
            "YouTube is rate-limiting this server's IP address (HTTP 429). "
            f"To avoid making it worse, new tries are paused for about {max(1, left // 60)} more minute(s)."
        )
    deadline = time.time() + 170
    first_error: ValueError | None = None
    rate_limited = False
    modes = yt_state.ordered_modes()
    has_cookie_mode = any(m["cookies"] for m in modes)
    for mode in modes:
        if first_error is not None and time.time() > deadline:
            break
        if rate_limited and not mode["cookies"]:
            continue  # logged-out requests are being throttled: do not add more of them
        try:
            result = analyze_media_url(url, None, yt_mode=mode)
        except ValueError as err:
            message = str(err).lower()
            if "rate-limiting" in message:
                first_error = first_error or err
                if mode["cookies"] or not has_cookie_mode:
                    yt_state.block_for(15 * 60)  # nothing left to try: pause all requests
                    raise first_error
                rate_limited = True  # one last try, logged in (cookies), then stop
                continue
            retryable = any(k in message for k in (
                "player response", "bot verification", "no downloadable", "not available", "failed to analyze", "timed out",
            ))
            if not retryable:
                raise
            first_error = first_error or err
            continue
        yt_state.remember(mode["name"])
        return result
    if rate_limited:
        yt_state.block_for(15 * 60)
    raise first_error or ValueError("Failed to analyze URL.")


def _run(url: str, job: dict) -> None:
    with _gate:
        try:
            job["result"] = _analyze(url)
        except ValueError as err:
            job["error"] = str(err)
        except Exception as err:
            traceback.print_exc()
            job["error"] = f"Failed to analyze URL ({type(err).__name__}: {err})"
        finally:
            job["finished_at"] = time.time()
            job["event"].set()


def _purge(now: float) -> None:
    for key in list(_jobs):
        job = _jobs[key]
        done = job.get("finished_at")
        if done and now - done > (RESULT_TTL if "result" in job else ERROR_TTL):
            _jobs.pop(key, None)


def analyze_with_wait(url: str, fresh: bool, wait_seconds: float = 20.0):
    """Return ("done", result) | ("pending", None) | ("error", message)."""
    now = time.time()
    key = youtube_video_id(url) or url
    with _lock:
        _purge(now)
        job = _jobs.get(key)
        if job and fresh and "error" in job and "rate-limiting" not in job["error"]:
            _jobs.pop(key, None)  # a fresh click retries a failed link (not while rate-limited)
            job = None
        if job is None:
            job = {"event": threading.Event(), "started_at": now}
            _jobs[key] = job
            threading.Thread(target=_run, args=(url, job), daemon=True).start()

    job["event"].wait(timeout=wait_seconds)
    if not job["event"].is_set():
        return "pending", None
    if "result" in job:
        return "done", job["result"]
    return "error", job.get("error", "Failed to analyze URL.")
