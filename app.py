from flask import Flask, request, send_file, render_template_string
import yt_dlp, os, shutil

app = Flask(__name__)
os.makedirs("downloads", exist_ok=True)

COOKIE_SRC = "/etc/secrets/cookies.txt"
COOKIE_DST = "/tmp/cookies.txt"
if os.path.exists(COOKIE_SRC):
    shutil.copy(COOKIE_SRC, COOKIE_DST)

PAGE = """
<!doctype html>
<meta name="viewport" content="width=device-width, initial-scale=1">
<h2>Video Downloader</h2>
<form method="post">
  <input name="url" placeholder="Video link" style="width:90%;padding:8px">
  <br><br>
  <button style="padding:8px 16px">Download</button>
</form>
<p style="color:red">{{ error }}</p>
<pre style="white-space:pre-wrap;font-size:12px">{{ info }}</pre>
"""

def base_opts():
    o = {"noplaylist": True, "quiet": True,
         # YouTube-এর JS ধাঁধা সমাধানের জন্য node/deno চালু
         "js_runtimes": {"node": {}, "deno": {}}}
    if os.path.exists(COOKIE_DST):
        o["cookiefile"] = COOKIE_DST
    return o

def list_formats(url):
    # ডিবাগ: কোন কোন ফরম্যাট পাওয়া যাচ্ছে তা দেখায়
    o = base_opts()
    o["ignore_no_formats_error"] = True
    o["skip_download"] = True
    with yt_dlp.YoutubeDL(o) as ydl:
        info = ydl.extract_info(url, download=False)
    lines = ["yt-dlp version: " + yt_dlp.version.__version__,
             "node: %s | deno: %s" % (shutil.which("node"), shutil.which("deno")),
             "Formats found: %d" % len(info.get("formats") or [])]
    for f in (info.get("formats") or [])[:40]:
        lines.append("%s | %s | %s | v:%s a:%s" % (
            f.get("format_id"), f.get("ext"),
            f.get("format_note") or f.get("resolution"),
            f.get("vcodec"), f.get("acodec")))
    return "\n".join(lines)

@app.route("/", methods=["GET", "POST"])
def home():
    error, info = "", ""
    if request.method == "POST":
        url = request.form.get("url", "").strip()
        opts = base_opts()
        opts["outtmpl"] = "downloads/%(id)s.%(ext)s"
        # সিঙ্গেল ফাইল (ভিডিও+অডিও) আগে, না পেলে যা আছে তাই
        opts["format"] = "b[ext=mp4]/b/bv*/ba"
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                res = ydl.extract_info(url, download=True)
                path = ydl.prepare_filename(res)
            return send_file(path, as_attachment=True)
        except Exception as e:
            error = str(e)[:300]
            try:
                info = list_formats(url)
            except Exception as e2:
                info = "format list failed: " + str(e2)[:300]
    return render_template_string(PAGE, error=error, info=info)
