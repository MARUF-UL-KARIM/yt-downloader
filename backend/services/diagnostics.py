import os
import re
import subprocess
import time
import urllib.request

from backend.config import Config


def _redact(text: str) -> str:
    return re.sub(r"[A-Za-z0-9_\-%.=]{40,}", "[redacted]", text)


def _timed_get(url: str) -> str:
    started = time.time()
    try:
        req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            return f"HTTP {resp.status} in {int((time.time() - started) * 1000)} ms"
    except Exception as err:
        return f"FAILED after {int((time.time() - started) * 1000)} ms ({type(err).__name__})"


def _mem() -> str:
    try:
        info = {}
        with open("/proc/meminfo") as fh:
            for line in fh:
                k, v = line.split(":", 1)
                info[k] = int(v.split()[0]) // 1024
        return f"available {info.get('MemAvailable')} MB of {info.get('MemTotal')} MB"
    except Exception:
        return "unknown"


def run_youtube_diagnostics(url: str) -> str:
    out = ["== Server =="]
    for label, binary, arg in (
        ("yt-dlp", Config.YTDLP_BIN, "--version"),
        ("ffmpeg", Config.FFMPEG_BIN, "-version"),
        ("ffprobe", Config.FFPROBE_BIN, "-version"),
        ("node", Config.NODE_BIN, "--version"),
    ):
        try:
            p = subprocess.run([binary, arg], capture_output=True, text=True, timeout=10)
            first = (p.stdout or p.stderr).strip().splitlines()[:1]
            out.append(f"{label}: {first[0][:60] if first else 'no output'}  ({binary})")
        except Exception as err:
            out.append(f"{label}: MISSING ({type(err).__name__})  ({binary})")
    try:
        out.append(f"cpu cores visible: {os.cpu_count()} | loadavg: {' '.join(f'{x:.2f}' for x in os.getloadavg())} | memory: {_mem()}")
    except Exception:
        pass

    out.append("\n== YouTube cookies (names only) ==")
    path = Config.YT_COOKIES_FILE
    if path and os.path.exists(path):
        text = open(path, encoding="utf-8", errors="ignore").read()
        rows = [l for l in text.splitlines() if l.strip() and not l.startswith("#")]
        names = {l.split("\t")[5] for l in rows if len(l.split("\t")) > 5}
        need = ["SID", "__Secure-3PSID", "__Secure-1PSID", "LOGIN_INFO", "SAPISID", "HSID", "SSID"]
        out.append(f"cookie rows: {len(rows)} | Netscape header: {'Netscape' in text}")
        out.append("  ".join(f"{n}:{'yes' if n in names else 'NO'}" for n in need))
    else:
        out.append("NO cookie file found (Render Secret File cookies.txt is missing)")

    out.append("\n== Network from this server ==")
    out.append(f"youtube.com: {_timed_get('https://www.youtube.com/')}")
    out.append(f"github.com: {_timed_get('https://github.com/')}")

    out.append("\n== yt-dlp run (verbose) ==")
    cmd = [
        Config.YTDLP_BIN, "-v", "--simulate", "--no-playlist",
        "--cache-dir", str(Config.TEMP_DIR / "ytdlp-cache"),
        "--socket-timeout", "60",
        "--extractor-args", "youtube:skip=translated_subs",
    ]
    if Config.NODE_BIN and os.path.exists(Config.NODE_BIN):
        cmd += ["--js-runtimes", f"node:{Config.NODE_BIN}"]
    if path:
        cmd += ["--cookies", path]
    if Config.YTDLP_PROXY:
        cmd += ["--proxy", Config.YTDLP_PROXY]
    cmd.append(url)
    started = time.time()
    timed_out = False
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=280)
        text, code = (proc.stdout or "") + (proc.stderr or ""), proc.returncode
    except subprocess.TimeoutExpired as err:
        timed_out, code = True, None
        raw = (err.stdout or b"") + (err.stderr or b"")
        text = raw.decode("utf-8", "ignore") if isinstance(raw, bytes) else str(raw)
    out.append(f"finished in {time.time() - started:.1f} s | exit code: {code} | timed out: {timed_out}")
    out.append(_redact("\n".join(text.splitlines()[-70:])))
    return "\n".join(out)
