from collections import deque
import subprocess
import threading
import os
import re
import shutil
from pathlib import Path
from backend.config import Config


def _have_ffprobe() -> bool:
    b = Config.FFPROBE_BIN
    return bool(b) and (os.path.exists(b) or shutil.which(b) is not None)


def _ffmpeg_info(file_path: Path) -> str:
    """ffmpeg prints stream info on stderr when given only an input."""
    try:
        proc = subprocess.run(
            [Config.FFMPEG_BIN, "-hide_banner", "-i", str(file_path)],
            capture_output=True, text=True, timeout=15,
        )
        return proc.stderr or ""
    except Exception:
        return ""


def probe_has_audio(file_path: Path) -> bool:
    if not _have_ffprobe():
        return " Audio:" in _ffmpeg_info(file_path)
    try:
        proc = subprocess.run(
            [
                Config.FFPROBE_BIN,
                "-v",
                "error",
                "-select_streams",
                "a",
                "-show_entries",
                "stream=index",
                "-of",
                "csv=p=0",
                str(file_path),
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        return bool(proc.stdout.strip())
    except Exception:
        return False


def probe_codecs(file_path: Path) -> tuple[str | None, str | None]:
    """First video and audio codec names (e.g. ("h264", "aac")); None when absent/unknown."""
    vcodec = acodec = None
    if _have_ffprobe():
        try:
            proc = subprocess.run(
                [Config.FFPROBE_BIN, "-v", "error", "-show_entries", "stream=codec_name,codec_type",
                 "-of", "csv=p=0", str(file_path)],
                capture_output=True, text=True, timeout=15,
            )
            for line in proc.stdout.splitlines():
                name, _, kind = line.strip().partition(",")
                if kind == "video" and not vcodec:
                    vcodec = name
                elif kind == "audio" and not acodec:
                    acodec = name
            return vcodec, acodec
        except Exception:
            pass
    info = _ffmpeg_info(file_path)
    m = re.search(r"Video:\s*([A-Za-z0-9_]+)", info)
    vcodec = m.group(1).lower() if m else None
    m = re.search(r"Audio:\s*([A-Za-z0-9_]+)", info)
    acodec = m.group(1).lower() if m else None
    return vcodec, acodec


def probe_duration(file_path: Path) -> float | None:
    if not _have_ffprobe():
        m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", _ffmpeg_info(file_path))
        if not m:
            return None
        total = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
        return total if total > 0 else None
    try:
        proc = subprocess.run(
            [
                Config.FFPROBE_BIN,
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(file_path),
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        val = float(proc.stdout.strip())
        return val if val > 0 else None
    except Exception:
        return None


def build_atempo_chain(speed: float) -> str:
    if speed == 0.5:
        return "atempo=0.5"
    if speed == 1.5:
        return "atempo=1.5"
    if speed == 2.0:
        return "atempo=2.0"
    if speed == 3.0:
        return "atempo=2.0,atempo=1.5"
    return "atempo=1.0"


def process_media_with_ffmpeg(
    job: dict,
    source_path: Path,
    output_path: Path,
    mode: str,
    container: str,
    trim_enabled: bool,
    trim_start: float,
    trim_end: float,
    speed: float,
    on_progress,
) -> None:
    source_duration = probe_duration(source_path) or job.get("duration") or 0.0
    has_audio = probe_has_audio(source_path)
    vcodec, acodec = probe_codecs(source_path)
    # codecs every phone gallery / player understands inside an MP4
    mp4_ready = (vcodec in (None, "h264", "hevc")) and (acodec in (None, "aac", "mp3"))

    if mode == "audio" and not has_audio:
        raise RuntimeError("Source media contains no audio track to extract.")

    t_start = max(0.0, trim_start) if trim_enabled else 0.0
    if trim_enabled and source_duration > 0 and t_start >= source_duration:
        raise RuntimeError(
            f"Trim start time ({int(t_start)}s) exceeds the video duration ({int(source_duration)}s)."
        )
    t_end = trim_end if (trim_enabled and trim_end > t_start) else source_duration
    if trim_enabled and source_duration > 0 and t_end > source_duration:
        t_end = source_duration
    clip_duration = (t_end - t_start) if t_end > t_start else source_duration
    expected_out_dur = clip_duration / speed if clip_duration > 0 else 0.0

    cmd = [Config.FFMPEG_BIN, "-y", "-progress", "pipe:1", "-nostats"]
    if trim_enabled and t_start > 0:
        cmd.extend(["-ss", str(t_start)])
    cmd.extend(["-i", str(source_path)])
    if trim_enabled and t_end > t_start:
        cmd.extend(["-t", str(t_end - t_start)])

    speed_changed = abs(speed - 1.0) > 1e-6
    source_ext = source_path.suffix.lstrip(".").lower()

    if mode == "audio":
        cmd.append("-vn")
        if speed_changed and has_audio:
            cmd.extend(["-filter:a", f"asetpts=PTS-STARTPTS,{build_atempo_chain(speed)}"])
        if container == "mp3":
            cmd.extend(["-c:a", "libmp3lame", "-b:a", "192k"])
        else:
            cmd.extend(["-c:a", "aac", "-b:a", "192k"])
    elif (not trim_enabled) and (not speed_changed) and (
        (container == "mp4" and mp4_ready) or (container != "mp4" and source_ext == container)
    ):
        if container == "mp4":
            # Re-wrap into a proper MP4 (no re-encode): writes the moov index + duration at the
            # start, which fixes fragmented/DASH files from Facebook, Instagram etc. that show
            # "00:00" or do not appear in the Gallery.
            cmd.extend(["-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn", "-c", "copy"])
            if vcodec == "hevc":
                cmd.extend(["-tag:v", "hvc1"])
            elif vcodec == "h264":
                cmd.extend(["-tag:v", "avc1"])
            cmd.extend(["-movflags", "+faststart"])
        else:
            cmd.extend(["-c", "copy"])
    else:
        vfilters = ["scale=trunc(iw/2)*2:trunc(ih/2)*2"]
        if speed_changed:
            vfilters.append(f"setpts=(PTS-STARTPTS)/{speed}")
        elif trim_enabled:
            vfilters.append("setpts=PTS-STARTPTS")
        cmd.extend(["-filter:v", ",".join(vfilters)])

        if has_audio:
            if speed_changed:
                cmd.extend(["-filter:a", f"asetpts=PTS-STARTPTS,{build_atempo_chain(speed)}"])
            elif trim_enabled:
                cmd.extend(["-filter:a", "asetpts=PTS-STARTPTS"])
        if container == "webm":
            cmd.extend(["-c:v", "libvpx-vp9", "-crf", "30", "-b:v", "0", "-deadline", "realtime"])
            if has_audio:
                cmd.extend(["-c:a", "libopus", "-b:a", "128k"])
        else:
            cmd.extend(["-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p"])
            if has_audio:
                cmd.extend(["-c:a", "aac", "-b:a", "192k"])
            if container == "mp4":
                cmd.extend(["-movflags", "+faststart"])

    cmd.extend(["-avoid_negative_ts", "make_zero", str(output_path)])

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    job["active_proc"] = proc

    stderr_tail: deque[str] = deque(maxlen=40)

    def _drain_stderr() -> None:
        if not proc.stderr:
            return
        try:
            for err_line in proc.stderr:
                stderr_tail.append(err_line.rstrip())
        except Exception:
            pass

    stderr_thread = threading.Thread(target=_drain_stderr, daemon=True)
    stderr_thread.start()

    try:
        if proc.stdout:
            for line in proc.stdout:
                if job["status"] == "cancelled":
                    proc.terminate()
                    raise RuntimeError("Processing cancelled by user.")
                line = line.strip()
                if line.startswith("out_time_us=") and expected_out_dur > 0:
                    try:
                        us = int(line.split("=", 1)[1])
                        pct = min(99, max(0, round((us / 1_000_000.0 / expected_out_dur) * 100)))
                        on_progress(pct)
                    except ValueError:
                        pass

        returncode = proc.wait(timeout=Config.JOB_TIMEOUT_SEC)
        stderr_thread.join(timeout=2)
        if job["status"] == "cancelled":
            raise RuntimeError("Processing cancelled by user.")
        if returncode != 0:
            tail = " ".join(list(stderr_tail)[-3:])
            raise RuntimeError(f"FFmpeg processing failed: {tail or f'exit code {returncode}'}")
    finally:
        job["active_proc"] = None
        if proc.poll() is None:
            try:
                proc.kill()
            except Exception:
                pass
