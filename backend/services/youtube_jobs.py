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

from backend.services.extractor import analyze_media_url

RESULT_TTL = 15 * 60
ERROR_TTL = 2 * 60

_lock = threading.Lock()
_gate = threading.Semaphore(1)
_jobs: dict[str, dict] = {}


def _run(url: str, job: dict) -> None:
    with _gate:
        try:
            job["result"] = analyze_media_url(url)
        except ValueError as err:
            job["error"] = str(err)
        except Exception:
            job["error"] = "Failed to analyze URL."
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
    with _lock:
        _purge(now)
        job = _jobs.get(url)
        if job and fresh and "error" in job:
            _jobs.pop(url, None)  # a fresh click retries a failed link
            job = None
        if job is None:
            job = {"event": threading.Event(), "started_at": now}
            _jobs[url] = job
            threading.Thread(target=_run, args=(url, job), daemon=True).start()

    job["event"].wait(timeout=wait_seconds)
    if not job["event"].is_set():
        return "pending", None
    if "result" in job:
        return "done", job["result"]
    return "error", job.get("error", "Failed to analyze URL.")
