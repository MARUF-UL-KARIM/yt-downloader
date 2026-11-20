from flask import Flask, request, send_file, render_template_string
import yt_dlp, os

app = Flask(__name__)
os.makedirs("downloads", exist_ok=True)

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
"""

@app.route("/", methods=["GET", "POST"])
def home():
    error = ""
    if request.method == "POST":
        url = request.form.get("url", "").strip()
        opts = {
            "format": "b[ext=mp4]/b",
            "outtmpl": "downloads/%(id)s.%(ext)s",
            "noplaylist": True,
            "quiet": True,
        }
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=True)
                path = ydl.prepare_filename(info)
            return send_file(path, as_attachment=True)
        except Exception as e:
            error = str(e)[:300]
    return render_template_string(PAGE, error=error)
