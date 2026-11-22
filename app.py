# Render/gunicorn entry point:  gunicorn app:app
# On hosts without ffmpeg / node (e.g. Render's plain Python runtime) the pip packages
# imageio-ffmpeg and nodejs-wheel-binaries provide them; this wires them into PATH first.
import os
import shutil
import sys


def _bootstrap_binaries() -> None:
    bin_dir = "/tmp/clipfetch_bin"
    try:
        os.makedirs(bin_dir, exist_ok=True)
    except OSError:
        return

    def link(src: str, name: str) -> None:
        dst = os.path.join(bin_dir, name)
        try:
            if os.path.lexists(dst):
                os.remove(dst)
            os.symlink(src, dst)
        except OSError:
            shutil.copy(src, dst)
        os.chmod(dst, 0o755)

    if not shutil.which("ffmpeg"):
        try:
            import imageio_ffmpeg

            link(imageio_ffmpeg.get_ffmpeg_exe(), "ffmpeg")
        except Exception:
            pass

    if not shutil.which("node"):
        try:
            import importlib.util

            spec = importlib.util.find_spec("nodejs_wheel")
            found = None
            for root in (spec.submodule_search_locations or []) if spec else []:
                for rel in ("bin/node", "node"):
                    cand = os.path.join(root, rel)
                    if os.path.isfile(cand) and os.access(cand, os.X_OK):
                        found = cand
                        break
                if not found:
                    for dirpath, _dirs, files in os.walk(root):
                        cand = os.path.join(dirpath, "node")
                        if "node" in files and os.access(cand, os.X_OK):
                            found = cand
                            break
                if found:
                    break
            if found:
                link(found, "node")
        except Exception:
            pass

    if not shutil.which("yt-dlp"):
        cand = os.path.join(os.path.dirname(sys.executable), "yt-dlp")
        if os.path.exists(cand):
            link(cand, "yt-dlp")

    os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")


_bootstrap_binaries()

from backend.app import app  # noqa: E402,F401
