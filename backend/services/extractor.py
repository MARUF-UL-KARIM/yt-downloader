import json
import re
import os
import subprocess
import tempfile
import threading
from urllib.parse import urlparse
from backend.config import Config
from backend.services import yt_state
from backend.utils.validators import (
    detect_source_name,
    has_direct_media_extension,
    is_youtube_url,
    validate_public_url,
    youtube_video_id,
)

STANDARD_BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)


def format_duration(seconds: float | None) -> str:
    if seconds is None or seconds < 0:
        return "Unknown"
    total = round(seconds)
    hrs = total // 3600
    mins = (total % 3600) // 60
    secs = total % 60
    if hrs > 0:
        return f"{hrs}:{mins:02d}:{secs:02d}"
    return f"{mins}:{secs:02d}"


def _yt_hint(stderr: str) -> str:
    """Short, redacted facts that explain opaque YouTube failures."""
    notes = []
    for line in stderr.splitlines():
        line = line.strip()
        if line.startswith("WARNING:"):
            notes.append(re.sub(r"[A-Za-z0-9_\-%.=]{40,}", "[x]", line[8:].strip())[:160])
    node_ok = bool(Config.NODE_BIN and os.path.exists(Config.NODE_BIN))
    hint = f" (Node.js for yt-dlp: {'found' if node_ok else 'NOT found'}"
    if notes:
        hint += "; yt-dlp notes: " + " | ".join(notes[-3:])
    return hint + ")"


def _classify_error(stderr: str, url: str) -> str:
    lower = stderr.lower()
    if "youtube" in lower and ("player response" in lower or "requested format is not available" in lower):
        return (
            "YouTube did not return a usable player response (cookies expired/rejected, or "
            "the JavaScript runtime is missing)" + _yt_hint(stderr) + "."
        )
    if "drm" in lower or "widevine" in lower or "encrypted" in lower:
        return "This media uses DRM or encryption protection and cannot be downloaded."
    if "sign in to confirm" in lower or "not a bot" in lower:
        return (
            "YouTube blocked this server (bot verification). Add fresh YouTube cookies: "
            'Render > Environment > Secret Files > "cookies.txt" (Netscape format), '
            'or paste them in "Cookies (Optional)".'
        )
    if "requested format is not available" in lower and "youtube" in lower:
        return (
            "YouTube returned no downloadable formats. Cookies may be expired or the server "
            "has no Node.js runtime. Re-export fresh cookies and try again."
        )
    if any(k in lower for k in ("private video", "login required", "authentication", "cookies")):
        return "This video is private or requires authentication. Only public videos are supported."
    if "geo" in lower or "not available in your country" in lower:
        return "This video is geo-restricted and unavailable from the server location."
    if "unsupported url" in lower:
        return f"This URL is not supported by yt-dlp and does not expose a direct video stream ({url})."
    if any(k in lower for k in ("404", "not found", "video unavailable")):
        return "The requested video was not found or has been removed."
    if "403" in lower or "forbidden" in lower:
        return "The remote host denied access (HTTP 403 Forbidden)."

    for line in stderr.splitlines():
        stripped = line.strip()
        if stripped.startswith("ERROR:"):
            return stripped[6:].strip()
    return "Could not extract playable media from this URL."


def _probe_direct_media(url: str) -> dict | None:
    host = (urlparse(url).hostname or "").lower()
    ua = "ClipFetch/1.0 (+https://github.com/clipfetch)" if host.endswith("wikimedia.org") else STANDARD_BROWSER_UA
    cmd = [
        Config.FFPROBE_BIN,
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        "-user_agent",
        ua,
        url,
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
    except Exception:
        return None

    if proc.returncode != 0 or not proc.stdout.strip():
        return None

    try:
        parsed = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return None

    streams = parsed.get("streams") or []
    video_stream = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio_stream = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if not video_stream and not audio_stream:
        return None

    fmt_info = parsed.get("format") or {}
    duration = float(fmt_info["duration"]) if fmt_info.get("duration") else None
    filesize = int(fmt_info["size"]) if fmt_info.get("size") else None
    tbr = round(int(fmt_info["bit_rate"]) / 1000) if fmt_info.get("bit_rate") else None

    parsed_url = urlparse(url)
    last_seg = (parsed_url.path.split("/") or ["direct_media"])[-1] or "direct_media"
    tags = fmt_info.get("tags") or {}
    title = tags.get("title") or last_seg.rsplit(".", 1)[0] or "Direct Media Stream"
    ext = last_seg.rsplit(".", 1)[-1].lower() if "." in last_seg else "mp4"
    if ext == "m3u8":
        ext = "mp4"

    fps = None
    avg_rate = (video_stream or {}).get("avg_frame_rate", "")
    if "/" in avg_rate:
        num, den = avg_rate.split("/", 1)
        if float(den) > 0:
            fps = round(float(num) / float(den))

    height = (video_stream or {}).get("height")
    width = (video_stream or {}).get("width")
    quality_tag = f"{height}p" if height else "Original"

    video_formats = []
    if video_stream:
        video_formats.append(
            {
                "id": "direct",
                "label": f"Original ({height}p)" if height else "Original Stream",
                "qualityTag": quality_tag,
                "height": height,
                "width": width,
                "fps": fps,
                "ext": ext,
                "vcodec": video_stream.get("codec_name"),
                "acodec": audio_stream.get("codec_name") if audio_stream else None,
                "filesize": filesize,
                "tbr": tbr,
                "hasVideo": True,
                "hasAudio": bool(audio_stream),
                "needsMerge": False,
                "audioFormatId": None,
            }
        )

    audio_formats = []
    if audio_stream:
        audio_formats.append(
            {
                "id": "direct-audio",
                "label": f"Original Audio ({(audio_stream.get('codec_name') or 'audio').upper()})",
                "qualityTag": "Audio",
                "height": None,
                "width": None,
                "fps": None,
                "ext": ext if ext in ("mp3", "m4a") else "m4a",
                "vcodec": None,
                "acodec": audio_stream.get("codec_name"),
                "filesize": None if video_stream else filesize,
                "tbr": round(int(audio_stream["bit_rate"]) / 1000)
                if audio_stream.get("bit_rate")
                else None,
                "hasVideo": False,
                "hasAudio": True,
                "needsMerge": False,
                "audioFormatId": None,
            }
        )

    return {
        "url": url,
        "webpageUrl": url,
        "title": title,
        "thumbnail": None,
        "duration": duration,
        "durationFormatted": format_duration(duration),
        "uploader": parsed_url.hostname,
        "source": detect_source_name(parsed_url),
        "extractor": "ffprobe-direct",
        "isDirectMedia": True,
        "hasAudioTrack": bool(audio_stream),
        "canTrim": bool(video_formats or audio_formats),
        "canChangeSpeed": bool(video_stream),
        "videoFormats": video_formats,
        "audioFormats": audio_formats,
        "limits": {
            "maxFileSizeMb": Config.MAX_FILE_SIZE_MB,
            "maxDurationSec": Config.MAX_DURATION_SEC,
        },
    }


def _build_formats(info: dict) -> tuple[list[dict], list[dict], bool]:
    raw_formats = info.get("formats") or []
    if any(f.get("has_drm") for f in raw_formats):
        raise ValueError("This media contains DRM-protected streams and cannot be downloaded.")

    audio_raw = [
        f
        for f in raw_formats
        if f.get("format_id")
        and f.get("acodec") not in (None, "none")
        and f.get("vcodec") in (None, "none")
    ]
    audio_raw.sort(key=lambda f: f.get("abr") or f.get("tbr") or 0, reverse=True)
    best_audio = audio_raw[0] if audio_raw else None

    video_raw = [
        f
        for f in raw_formats
        if f.get("format_id")
        and f.get("ext") != "mhtml"
        and f.get("protocol") != "mhtml"
        and f.get("format_note") != "storyboard"
        and (
            f.get("vcodec") not in (None, "none")
            or (f.get("vcodec") in (None, "none") and f.get("acodec") in (None, "none"))
        )
    ]
    has_unknown_codec_video = any(
        f.get("vcodec") in (None, "none") and f.get("acodec") in (None, "none") for f in video_raw
    )
    has_muxed = any(f.get("acodec") not in (None, "none") for f in video_raw) or has_unknown_codec_video
    has_audio_track = bool(best_audio or has_muxed or info.get("acodec") not in (None, "none"))

    def _unknown_labels(fmt: dict) -> tuple[str, str]:
        fid = (fmt.get("format_id") or "").lower()
        if fid == "hd":
            return "HD", "HD"
        if fid == "sd":
            return "SD", "SD"
        note = (fmt.get("format_note") or "").strip()
        if note:
            return note, note[:16]
        tag = (fmt.get("format_id") or "Original").upper()
        return tag, tag[:16]

    by_tier: dict[str, dict] = {}
    for f in video_raw:
        height = f.get("height") or 0
        is_muxed = f.get("acodec") not in (None, "none") or (
            f.get("vcodec") in (None, "none") and f.get("acodec") in (None, "none")
        )
        needs_merge = (not is_muxed) and (best_audio is not None)
        est_size = f.get("filesize") or f.get("filesize_approx")
        audio_size = (best_audio or {}).get("filesize") or (best_audio or {}).get("filesize_approx")
        merged_size = (est_size + audio_size) if (needs_merge and est_size and audio_size) else est_size

        u_label, u_tag = _unknown_labels(f)
        opt = {
            "id": f["format_id"],
            "label": f"{height}p" if height > 0 else u_label,
            "qualityTag": f"{height}p" if height > 0 else u_tag,
            "height": height if height > 0 else None,
            "width": f.get("width") if (f.get("width") or 0) > 0 else None,
            "fps": round(f["fps"]) if f.get("fps") else None,
            "ext": f.get("ext") or "mp4",
            "vcodec": f.get("vcodec") if f.get("vcodec") not in (None, "none") else None,
            "acodec": (
                f.get("acodec") if f.get("acodec") not in (None, "none") else "aac"
            )
            if is_muxed
            else (best_audio or {}).get("acodec"),
            "filesize": merged_size,
            "tbr": round(f["tbr"]) if f.get("tbr") else None,
            "hasVideo": True,
            "hasAudio": is_muxed or (best_audio is not None),
            "needsMerge": needs_merge,
            "audioFormatId": best_audio["format_id"] if needs_merge and best_audio else None,
        }

        def _score(item: dict) -> float:
            s = 0.0
            if item["ext"] == "mp4":
                s += 1000
            if not item["needsMerge"]:
                s += 500
            vc = (item.get("vcodec") or "").lower()
            if vc.startswith("avc1") or vc.startswith("h264"):
                s += 200
            s += (item.get("tbr") or 0) / 100.0
            return s

        tier_key = f"h:{height}" if height > 0 else f"id:{f['format_id']}"
        if tier_key not in by_tier or _score(opt) > _score(by_tier[tier_key]):
            by_tier[tier_key] = opt

    def _tier_rank(item: dict) -> float:
        if item.get("height"):
            return float(item["height"]) * 10.0
        fid = str(item.get("id", "")).lower()
        if fid == "hd":
            return 7200.0
        if fid == "sd":
            return 3600.0
        return float(item.get("tbr") or 100.0)

    sorted_heights = sorted(by_tier.values(), key=_tier_rank, reverse=True)
    if not sorted_heights and info.get("url"):
        h = info.get("height")
        sorted_heights.append(
            {
                "id": "best",
                "label": f"Original ({h}p)" if h else "Original",
                "qualityTag": f"{h}p" if h else "Original",
                "height": h,
                "width": info.get("width"),
                "fps": None,
                "ext": info.get("ext") or "mp4",
                "vcodec": info.get("vcodec") if info.get("vcodec") != "none" else None,
                "acodec": info.get("acodec") if info.get("acodec") != "none" else None,
                "filesize": info.get("filesize") or info.get("filesize_approx"),
                "tbr": None,
                "hasVideo": True,
                "hasAudio": info.get("acodec") not in (None, "none"),
                "needsMerge": False,
                "audioFormatId": None,
            }
        )

    video_formats = []
    if sorted_heights:
        top = dict(sorted_heights[0])
        if top.get("height"):
            top["label"] = f"Original ({top['height']}p)"
            top["qualityTag"] = f"{top['height']}p"
        elif top.get("qualityTag") != "Original":
            top["label"] = f"Original ({top['qualityTag']})"
        else:
            top["label"] = "Original (Best Available)"
        video_formats.append(top)
        for fmt in sorted_heights[1:]:
            video_formats.append(fmt)

    audio_formats = []
    seen_abr = set()
    for a in audio_raw[:4]:
        kbps = round(a.get("abr") or a.get("tbr") or 0)
        ext = a.get("ext") or "m4a"
        key = f"{ext}-{kbps}"
        if key in seen_abr:
            continue
        seen_abr.add(key)
        audio_formats.append(
            {
                "id": a["format_id"],
                "label": f"{kbps} kbps ({ext.upper()})" if kbps > 0 else f"Audio ({ext.upper()})",
                "qualityTag": f"{kbps}kbps" if kbps > 0 else "Audio",
                "height": None,
                "width": None,
                "fps": None,
                "ext": ext,
                "vcodec": None,
                "acodec": a.get("acodec"),
                "filesize": a.get("filesize") or a.get("filesize_approx"),
                "tbr": kbps or None,
                "hasVideo": False,
                "hasAudio": True,
                "needsMerge": False,
                "audioFormatId": None,
            }
        )

    if not audio_formats and has_audio_track:
        audio_formats.append(
            {
                "id": sorted_heights[0]["id"] if sorted_heights else "best",
                "label": "Extract Audio from Video",
                "qualityTag": "Extracted",
                "height": None,
                "width": None,
                "fps": None,
                "ext": "mp3",
                "vcodec": None,
                "acodec": "mp3",
                "filesize": None,
                "tbr": 192,
                "hasVideo": False,
                "hasAudio": True,
                "needsMerge": False,
                "audioFormatId": None,
            }
        )

    return video_formats, audio_formats, has_audio_track


def _parse_duration_string(raw: str | None) -> float | None:
    if not raw or not isinstance(raw, str):
        return None
    cleaned = raw.strip()
    if not cleaned:
        return None
    try:
        if ":" not in cleaned:
            val = float(cleaned)
            return val if val > 0 else None
        parts = [float(p) for p in cleaned.split(":")]
        if any(p < 0 for p in parts):
            return None
        if len(parts) == 2:
            total = parts[0] * 60 + parts[1]
            return total if total > 0 else None
        if len(parts) == 3:
            total = parts[0] * 3600 + parts[1] * 60 + parts[2]
            return total if total > 0 else None
    except ValueError:
        return None
    return None


def _probe_stream_duration(stream_url: str, headers: dict | None = None) -> float | None:
    check = validate_public_url(stream_url)
    if not check.get("valid") or not check.get("normalized_url"):
        return None
    ua = (headers or {}).get("User-Agent") or (headers or {}).get("user-agent") or STANDARD_BROWSER_UA
    header_lines = []
    if isinstance(headers, dict):
        for k, v in headers.items():
            kl = str(k).lower()
            if kl in ("user-agent", "range", "host"):
                continue
            if isinstance(v, str) and "\r" not in k and "\n" not in k and "\r" not in v and "\n" not in v:
                header_lines.append(f"{k}: {v}")
    cmd = [
        Config.FFPROBE_BIN,
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        "-user_agent",
        ua,
    ]
    if header_lines:
        cmd.extend(["-headers", "\r\n".join(header_lines) + "\r\n"])
    cmd.append(check["normalized_url"])
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=12)
        if proc.returncode == 0 and proc.stdout.strip():
            parsed = json.loads(proc.stdout)
            dur = float((parsed.get("format") or {}).get("duration") or 0)
            if dur > 0:
                return dur
    except Exception:
        pass
    return None


def _resolve_info_duration(info: dict) -> float | None:
    dur = info.get("duration")
    if isinstance(dur, (int, float)) and dur > 0:
        return float(dur)
    from_str = _parse_duration_string(info.get("duration_string"))
    if from_str:
        return from_str

    formats = list(info.get("requested_formats") or []) + list(info.get("formats") or [])
    for fmt in formats:
        fd = fmt.get("duration")
        if isinstance(fd, (int, float)) and fd > 0:
            return float(fd)
        frags = fmt.get("fragments") or []
        if frags:
            s = sum(float(fr.get("duration") or 0) for fr in frags if isinstance(fr, dict))
            if s > 0:
                return s

    candidates = []
    for fmt in formats:
        u = fmt.get("url")
        if not isinstance(u, str) or not u.startswith(("http://", "https://")):
            continue
        if fmt.get("ext") == "mhtml" or fmt.get("protocol") == "mhtml" or fmt.get("format_note") == "storyboard":
            continue
        score = 0
        if fmt.get("protocol") in (None, "https", "http"):
            score += 100
        if fmt.get("ext") == "mp4":
            score += 50
        if fmt.get("vcodec") not in (None, "none"):
            score += 20
        if fmt.get("acodec") not in (None, "none"):
            score += 20
        candidates.append((score, u, fmt.get("http_headers") or info.get("http_headers")))

    if isinstance(info.get("url"), str) and info["url"].startswith(("http://", "https://")):
        candidates.append((90, info["url"], info.get("http_headers")))

    candidates.sort(key=lambda x: x[0], reverse=True)
    seen = set()
    for _, u, hdrs in candidates:
        if u in seen:
            continue
        seen.add(u)
        probed = _probe_stream_duration(u, hdrs)
        if probed and probed > 0:
            return probed
        if len(seen) >= 2:
            break
    return None


class _Proc:
    """Looks like subprocess.CompletedProcess so the code below handles both the same way."""

    def __init__(self, returncode: int, stdout: str, stderr: str):
        self.returncode, self.stdout, self.stderr = returncode, stdout, stderr


class _CaptureLogger:
    def __init__(self):
        self.lines: list[str] = []

    def debug(self, msg):
        pass

    def info(self, msg):
        pass

    def warning(self, msg):
        self.lines.append("WARNING: " + str(msg))

    def error(self, msg):
        self.lines.append("ERROR: " + str(msg))


def _ytdlp_inprocess(url: str, yt_mode: dict) -> "_Proc | None":
    """Run yt-dlp inside this Python process.

    Saves the 3-10 s a fresh yt-dlp process needs to start on a small server, because yt-dlp
    stays imported. Returns None when it cannot be used (caller then starts the normal process).
    """
    try:
        import yt_dlp
    except Exception:
        return None

    logger = _CaptureLogger()
    extractor_args: dict = {"skip": ["translated_subs"]}
    if yt_mode.get("client"):
        extractor_args["player_client"] = [yt_mode["client"]]
    opts: dict = {
        "quiet": True,
        "skip_download": True,
        "noplaylist": True,
        "socket_timeout": 60,
        "cachedir": str(Config.TEMP_DIR / "ytdlp-cache"),
        "extractor_args": {"youtube": extractor_args},
        "logger": logger,
    }
    if Config.NODE_BIN and os.path.exists(Config.NODE_BIN):
        opts["js_runtimes"] = {"node": {"path": Config.NODE_BIN}}
    if yt_mode.get("cookies") and Config.YT_COOKIES_FILE:
        opts["cookiefile"] = Config.YT_COOKIES_FILE
    if Config.YTDLP_PROXY:
        opts["proxy"] = Config.YTDLP_PROXY

    box: dict = {}

    def work():
        try:
            Config.TEMP_DIR.mkdir(parents=True, exist_ok=True)
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=False)
                box["info"] = ydl.sanitize_info(info)
        except Exception as err:  # yt_dlp.utils.DownloadError and friends
            box["error"] = str(err)

    thread = threading.Thread(target=work, daemon=True)
    thread.start()
    thread.join(timeout=270)
    if thread.is_alive():
        return _Proc(1, "", "ERROR: Media inspection timed out. The remote server took too long to respond.")
    if "info" in box:
        return _Proc(0, json.dumps(box["info"], default=str), "\n".join(logger.lines))
    return _Proc(1, "", "\n".join(logger.lines + [box.get("error", "ERROR: yt-dlp failed")]))


def _prewarm_ytdlp() -> None:
    try:
        import yt_dlp  # noqa: F401
        import yt_dlp.extractor.youtube  # noqa: F401
    except Exception:
        pass


threading.Thread(target=_prewarm_ytdlp, daemon=True).start()


def analyze_media_url(url: str, cookies_text: str | None = None, yt_mode: dict | None = None) -> dict:
    parsed = urlparse(url)
    direct_ext = has_direct_media_extension(parsed.path)

    cmd = [
        Config.YTDLP_BIN,
        "--dump-single-json",
        "--no-playlist",
        "--socket-timeout",
        "20",
    ]
    if not is_youtube_url(url):
        cmd.append("--no-warnings")  # YouTube warnings are kept: they explain failures
    if direct_ext:
        cmd.extend(["--user-agent", STANDARD_BROWSER_UA])
    if Config.NODE_BIN and os.path.exists(Config.NODE_BIN):
        cmd.extend(["--js-runtimes", f"node:{Config.NODE_BIN}"])
    is_yt = is_youtube_url(url)
    if is_yt:
        # keep yt-dlp's cache (solved YouTube challenges) so repeat requests are fast
        cmd.extend([
            "--cache-dir", str(Config.TEMP_DIR / "ytdlp-cache"),
            "--socket-timeout", "60",
            "--extractor-args", yt_state.extractor_args(yt_mode),
        ])
    if Config.YTDLP_PROXY:
        cmd.extend(["--proxy", Config.YTDLP_PROXY])

    ephemeral_cookies_path: str | None = None
    if cookies_text and cookies_text.strip():
        Config.TEMP_DIR.mkdir(parents=True, exist_ok=True)
        fd, ephemeral_cookies_path = tempfile.mkstemp(
            prefix="cookies_", suffix=".txt", dir=str(Config.TEMP_DIR)
        )
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(cookies_text.strip() + "\n")
        os.chmod(ephemeral_cookies_path, 0o600)
        cmd.extend(["--cookies", ephemeral_cookies_path])
    elif is_yt and yt_mode is not None and not yt_mode["cookies"]:
        pass  # this mode deliberately uses no cookies
    elif is_yt and Config.YT_COOKIES_FILE:
        cmd.extend(["--cookies", Config.YT_COOKIES_FILE])
    elif Config.COOKIES_FILE:
        cmd.extend(["--cookies", Config.COOKIES_FILE])
    cmd.append(url)

    ytdlp_error = None
    try:
        # YouTube needs a JS challenge solved by Node, which is slow on small free servers
        proc = None
        if is_yt and yt_mode is not None and not (cookies_text and cookies_text.strip()):
            proc = _ytdlp_inprocess(url, yt_mode)
        if proc is None:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=270 if is_yt else 35)
        if proc.returncode == 0 and proc.stdout.strip():
            info = json.loads(proc.stdout)
            if is_yt:
                yt_state.store_info(youtube_video_id(url), info)
            if info.get("is_live"):
                raise ValueError("Live streams cannot be pre-analyzed or downloaded as finite files.")

            video_formats, audio_formats, has_audio_track = _build_formats(info)
            if direct_ext and len(video_formats) <= 1 and (not video_formats or not video_formats[0].get("height")):
                probed = _probe_direct_media(url)
                if probed:
                    return probed

            if not video_formats and not audio_formats:
                raise ValueError("No downloadable video or audio formats were found at this URL.")

            duration = _resolve_info_duration(info)
            if duration is not None and duration > Config.MAX_DURATION_SEC:
                raise ValueError(
                    f"Video duration ({format_duration(duration)}) exceeds server limit of {format_duration(Config.MAX_DURATION_SEC)}."
                )

            return {
                "url": url,
                "webpageUrl": info.get("webpage_url") or url,
                "title": info.get("title") or "Untitled Media",
                "thumbnail": info.get("thumbnail"),
                "duration": duration,
                "durationFormatted": format_duration(duration),
                "uploader": info.get("uploader") or info.get("channel"),
                "source": detect_source_name(parsed),
                "extractor": info.get("extractor_key") or info.get("extractor") or "yt-dlp",
                "isDirectMedia": direct_ext,
                "hasAudioTrack": has_audio_track,
                "canTrim": bool(video_formats or audio_formats),
                "canChangeSpeed": len(video_formats) > 0,
                "videoFormats": video_formats,
                "audioFormats": audio_formats,
                "limits": {
                    "maxFileSizeMb": Config.MAX_FILE_SIZE_MB,
                    "maxDurationSec": Config.MAX_DURATION_SEC,
                },
            }

        ytdlp_error = _classify_error(proc.stderr or "", url)
    except subprocess.TimeoutExpired:
        ytdlp_error = "Media inspection timed out. The remote server took too long to respond."
    except ValueError as err:
        ytdlp_error = str(err)
    except Exception as err:
        ytdlp_error = str(err)
    finally:
        if ephemeral_cookies_path and os.path.exists(ephemeral_cookies_path):
            try:
                os.unlink(ephemeral_cookies_path)
            except Exception:
                pass

    if not is_yt and (direct_ext or (ytdlp_error and "drm" not in ytdlp_error.lower())):
        probed = _probe_direct_media(url)
        if probed:
            if probed["duration"] and probed["duration"] > Config.MAX_DURATION_SEC:
                raise ValueError(
                    f"Video duration ({format_duration(probed['duration'])}) exceeds server limit."
                )
            return probed

    raise ValueError(ytdlp_error or "Unable to analyze this URL.")


def get_tool_versions() -> dict:
    def _ver(binary: str, flag: str) -> str | None:
        try:
            proc = subprocess.run([binary, flag], capture_output=True, text=True, timeout=4)
            if proc.returncode == 0 and proc.stdout.strip():
                return proc.stdout.splitlines()[0][:80]
        except Exception:
            pass
        return None

    return {
        "ytdlp": _ver(Config.YTDLP_BIN, "--version"),
        "ffmpeg": _ver(Config.FFMPEG_BIN, "-version"),
        "ffprobe": _ver(Config.FFPROBE_BIN, "-version"),
    }
