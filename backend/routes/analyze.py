import urllib.request
from flask import Blueprint, Response, jsonify, request
from backend.services.extractor import STANDARD_BROWSER_UA, analyze_media_url
from backend.services.diagnostics import run_youtube_diagnostics
from backend.services.youtube_jobs import analyze_with_wait
from backend.utils.validators import is_youtube_url, safe_urlopen, validate_public_url

analyze_bp = Blueprint("analyze", __name__)


@analyze_bp.post("/api/analyze")
def analyze_endpoint():
    body = request.get_json(silent=True) or {}
    raw_url = body.get("url", "")
    validation = validate_public_url(raw_url)
    if not validation.get("valid"):
        return jsonify({"error": validation.get("error", "Invalid URL.")}), 400

    cookies_text = body.get("cookiesText")
    if cookies_text is not None and (not isinstance(cookies_text, str) or len(cookies_text) > 256 * 1024):
        return jsonify({"error": "Cookies text exceeds 256 KB safety limit."}), 400

    normalized = validation["normalized_url"]
    uses_own_cookies = bool(cookies_text and cookies_text.strip())
    if is_youtube_url(normalized) and not uses_own_cookies:
        # Long-running: analyse in the background, the browser polls with {"poll": true}
        status, payload = analyze_with_wait(normalized, fresh=body.get("poll") is not True)
        if status == "pending":
            return jsonify({"pending": True}), 202
        if status == "error":
            return jsonify({"error": payload}), 422
        return jsonify(payload)

    try:
        result = analyze_media_url(normalized, cookies_text)
        return jsonify(result)
    except ValueError as err:
        return jsonify({"error": str(err)}), 422
    except Exception as err:
        import traceback
        traceback.print_exc()
        return jsonify({"error": f"Failed to analyze URL ({type(err).__name__}: {err})"}), 500


@analyze_bp.get("/api/thumbnail")
def thumbnail_proxy():
    raw_url = request.args.get("url", "")
    validation = validate_public_url(raw_url)
    if not validation.get("valid"):
        return ("", 400)

    req = urllib.request.Request(
        validation["normalized_url"], headers={"User-Agent": STANDARD_BROWSER_UA}
    )
    try:
        with safe_urlopen(req, timeout=10) as resp:
            ctype = resp.headers.get("Content-Type", "")
            if not ctype.startswith("image/"):
                return ("", 415)
            data = resp.read(8 * 1024 * 1024 + 1)
            if len(data) > 8 * 1024 * 1024:
                return ("", 413)
            return Response(data, mimetype=ctype, headers={"Cache-Control": "public, max-age=300"})
    except Exception:
        return ("", 502)


@analyze_bp.get("/api/diag")
def diagnostics_endpoint():
    """Troubleshooting page: /api/diag?url=<youtube link> (secrets are never printed)."""
    target = request.args.get("url", "")
    if not is_youtube_url(target):
        return Response("Use: /api/diag?url=<a youtube link>", status=400, mimetype="text/plain")
    return Response(run_youtube_diagnostics(target), mimetype="text/plain")
